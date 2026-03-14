import { inject, Injectable } from '@angular/core';
import { Nostr } from './nostr';
import { WebRTC } from './webrtc';
import { ChatCredentials, PeerMedia, WebRTCEventType, WebRTCNostrEvent } from '../dtos';

@Injectable({
  providedIn: 'root',
})
export class MediaChat {
  private readonly nostr = inject(Nostr);
  private readonly webRTC = inject(WebRTC);

  private mediaStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private credentials: ChatCredentials | null = null;
  private readonly peersStreams: Record<string, PeerMedia> = {};
  private readonly pendingIceCandidates: Record<string, RTCIceCandidateInit[]> = {};

  public init(credentials: ChatCredentials): void {
    this.credentials = credentials;
  }

  public get isInitialized(): boolean {
    return Boolean(this.credentials);
  }

  public async start(): Promise<void> {
    if (!this.isInitialized) throw Error('Chat requer ser configurado antes de ser iniciado.');

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });

    this.nostr.initNostr(this.credentials!.room).subscribe({
      next: (evt) => {
        this.handleEvent(JSON.parse(evt.content), evt.pubkey);
      },
    });

    await this.sendChatEvent(this.credentials!.room, {
      type: WebRTCEventType.Join,
    });
  }

  public async startScreenShare(): Promise<void> {
    try {
      await navigator.mediaDevices
        .getDisplayMedia({
          video: true,
          audio: false,
        })
        .then((x) => (this.screenStream = x))
        .catch(console.error);
      const screenTrack = this.screenStream!.getVideoTracks()[0];
      const allPeers = this.webRTC.getAllPeers();
      for (const peer of allPeers) {
        peer.peerConnection.addTrack(screenTrack, this.screenStream!);
      }

      screenTrack.addEventListener('ended', () => {
        this.stopScreenShare();
      });
    } catch (err) {
      console.error('Erro ao abrir compartilhamento de tela:', err);
    }
  }

  public async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;

    this.screenStream.getTracks().forEach((track) => track.stop());
    this.screenStream = null;

    const allPeers = this.webRTC.getAllPeers();
    for (const peer of allPeers) {
      const senders = peer.peerConnection.getSenders();
      const videoSender = senders.find((x) => x.track?.kind == 'video');
      if (videoSender) {
        peer.peerConnection.removeTrack(videoSender);
      }
    }
  }

  private async sendChatEvent(
    room: string,
    content: WebRTCNostrEvent,
    targetPubkey?: string,
  ): Promise<void> {
    if (targetPubkey) {
      content.target = targetPubkey;
    }
    await this.nostr.sendEvent(content, room);
  }

  private async flushPendingIceCandidates(pubkey: string): Promise<void> {
    const pc = this.webRTC.getPeerConnection(pubkey);
    if (!pc?.remoteDescription) return;

    const pendingCandidates = this.pendingIceCandidates[pubkey];
    if (!pendingCandidates?.length) return;

    for (const candidate of pendingCandidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    delete this.pendingIceCandidates[pubkey];
  }

  private createConnection(pubkey: string): RTCPeerConnection {
    let pc = this.webRTC.getPeerConnection(pubkey);
    if (pc) {
      return pc;
    }

    pc = this.webRTC.connectToPeer(pubkey);
    this.mediaStream?.getTracks().forEach((track) => pc.addTrack(track, this.mediaStream!));
    pc.addEventListener('track', (evt) => {
      console.log('webrtc evt', evt);
      const track = evt.track;
      const stream = evt.streams[0];
      if (!this.peersStreams[pubkey]) {
        this.peersStreams[pubkey] = {
          mediaStream: stream,
          audioHtmlElement: document.createElement('audio'),
          screenHtmlElement: null,
        };
      }

      let mediaElement: HTMLAudioElement | HTMLVideoElement;

      if (track.kind == 'audio') {
        mediaElement = document.createElement('audio');
        this.peersStreams[pubkey] = {
          mediaStream: stream,
          audioHtmlElement: mediaElement,
          screenHtmlElement: null,
        };
      } else if (track.kind == 'video') {
        const videoElement = document.createElement('video');
        videoElement.playsInline = true;
        videoElement.controls = true;
        videoElement.style.width = '100%';
        mediaElement = videoElement;
        this.peersStreams[pubkey].screenHtmlElement = videoElement;
      } else {
        return;
      }

      mediaElement.srcObject = stream;
      mediaElement.autoplay = true;
      document.body.appendChild(mediaElement);

      track.addEventListener('ended', () => {
        console.log('track ended', track.kind);
        if (track.kind == 'video') {
          this.peersStreams[pubkey].screenHtmlElement?.remove();
          this.peersStreams[pubkey].screenHtmlElement = null;

          return;
        }

        if (track.kind == 'audio') {
          this.peersStreams[pubkey].audioHtmlElement?.remove();
          delete this.peersStreams[pubkey];
        }
      });

      stream.addEventListener('removetrack', (ev) => {
        console.log('removetrack', track.kind);
        const removedTrack = ev.track;
        console.log('Track removida remotamente:', removedTrack.kind);

        if (removedTrack.kind == 'video') {
          this.peersStreams[pubkey].screenHtmlElement?.remove();
          this.peersStreams[pubkey].screenHtmlElement = null;
          return;
        }

        if (removedTrack.kind == 'audio') {
          this.peersStreams[pubkey].audioHtmlElement?.remove();
          delete this.peersStreams[pubkey];
        }
      });
    });

    pc.addEventListener('icecandidate', async (evt) => {
      if (!evt.candidate) return;
      await this.sendChatEvent(
        this.credentials?.room!,
        {
          type: WebRTCEventType.IceCandidate,
          candidate: evt.candidate.toJSON(),
        },
        pubkey,
      );
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      if (
        pc.iceConnectionState == 'disconnected' ||
        pc.iceConnectionState == 'failed' ||
        pc.iceConnectionState == 'closed'
      ) {
        this.peersStreams[pubkey]?.screenHtmlElement?.remove();
        if (this.peersStreams[pubkey]) {
          this.peersStreams[pubkey].screenHtmlElement = null;
        }
        this.peersStreams[pubkey]?.audioHtmlElement?.remove();
        delete this.peersStreams[pubkey];
        delete this.pendingIceCandidates[pubkey];
      }
    });

    pc.addEventListener('negotiationneeded', async (evt) => {
      try {
        if (pc.signalingState != 'stable') return;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this.sendChatEvent(
          this.credentials?.room!,
          {
            type: WebRTCEventType.Offer,
            sdp: offer,
          },
          pubkey,
        );
      } catch (err) {
        console.error('Erro na renegociação:', err);
      }
    });

    return pc;
  }

  private async handleEvent(content: WebRTCNostrEvent, pubkey: string): Promise<void> {
    console.log('nostr evt', content);
    if (content.target && content.target != this.nostr.myPublicKey) return;

    if (content.type == WebRTCEventType.Join) {
      this.createConnection(pubkey);

      return;
    }

    if (content.type == WebRTCEventType.Offer) {
      const pc = this.createConnection(pubkey);
      await pc.setRemoteDescription(new RTCSessionDescription(content.sdp!));
      await this.flushPendingIceCandidates(pubkey);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.sendChatEvent(
        this.credentials?.room!,
        {
          type: WebRTCEventType.Answer,
          sdp: answer,
        },
        pubkey,
      );

      return;
    }

    if (content.type == WebRTCEventType.Answer) {
      const pc = this.webRTC.getPeerConnection(pubkey);
      await pc?.setRemoteDescription(new RTCSessionDescription(content.sdp!));
      await this.flushPendingIceCandidates(pubkey);
      return;
    }

    if (content.type == WebRTCEventType.IceCandidate) {
      const pc = this.webRTC.getPeerConnection(pubkey) ?? this.createConnection(pubkey);
      if (!content.candidate) return;

      if (!pc.remoteDescription) {
        this.pendingIceCandidates[pubkey] ??= [];
        this.pendingIceCandidates[pubkey].push(content.candidate);
        return;
      }

      await pc.addIceCandidate(new RTCIceCandidate(content.candidate));
    }
  }
}
