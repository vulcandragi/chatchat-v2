import { computed, inject, Injectable, signal } from '@angular/core';
import { NostrEvent } from '@nostr/tools';
import { Nostr } from './nostr';
import { WebRTC } from './webrtc';
import {
  ChatCredentials,
  NostrRoomSession,
  PeerMedia,
  WebRTCEventType,
  WebRTCNostrEvent,
} from '../dtos';

@Injectable({
  providedIn: 'root',
})
export class MediaChat {
  private static readonly PRESENCE_INTERVAL_MS = 10000;
  private static readonly STALE_PEER_TIMEOUT_MS = 45000;

  private readonly nostr = inject(Nostr);
  private readonly webRTC = inject(WebRTC);
  private readonly screenSharingState = signal(false);
  private readonly microphoneMutedState = signal(false);

  private mediaStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private credentials: ChatCredentials | null = null;
  private roomSession: NostrRoomSession | null = null;
  private started = false;
  private readonly peersStreams: Record<string, PeerMedia> = {};
  private readonly peerNicks: Record<string, string> = {};
  private readonly peerLastSeenAt: Record<string, number> = {};
  private readonly pendingIceCandidates: Record<string, RTCIceCandidateInit[]> = {};
  private readonly makingOffer: Record<string, boolean> = {};
  private readonly ignoreOffer: Record<string, boolean> = {};
  private readonly isSettingRemoteAnswerPending: Record<string, boolean> = {};
  private presenceIntervalId: number | null = null;
  private stalePeersIntervalId: number | null = null;
  private readonly beforeUnloadHandler = (): void => {
    this.stop(false).catch((err) => {
      console.error('[MediaChat] stop on unload failed', err);
    });
  };

  public init(credentials: ChatCredentials): void {
    this.credentials = credentials;
    this.log('initialized credentials', credentials);
  }

  public get isInitialized(): boolean {
    return Boolean(this.credentials);
  }

  public readonly isScreenSharing = computed(() => this.screenSharingState());

  public readonly isMicrophoneMuted = computed(() => this.microphoneMutedState());

  public async start(): Promise<void> {
    if (!this.isInitialized) throw Error('Chat requer ser configurado antes de ser iniciado.');

    if (this.started) {
      this.log('restarting active session');
      await this.stop();
    }

    this.log('starting room session', {
      room: this.credentials!.room,
      pubkey: this.nostr.myPublicKey,
    });

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    this.microphoneMutedState.set(false);

    this.roomSession = this.nostr.initNostr(this.credentials!.room);
    this.roomSession.events$.subscribe({
      next: (evt: NostrEvent) => {
        this.handleEvent(JSON.parse(evt.content), evt.pubkey).catch((err) => {
          console.error('[MediaChat] failed to handle event', err);
        });
      },
      error: (err) => {
        console.error('[MediaChat] nostr subscription error', err);
      },
    });

    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    this.started = true;
    this.startPresenceLoop();

    await this.sendChatEvent(this.credentials!.room, {
      type: WebRTCEventType.Join,
    });
  }

  public async stop(notifyPeers: boolean = true): Promise<void> {
    if (!this.started && !this.mediaStream && !this.screenStream && !this.roomSession) return;

    this.log('stopping room session', { notifyPeers });

    if (notifyPeers && this.credentials) {
      try {
        await this.sendChatEvent(this.credentials.room, {
          type: WebRTCEventType.Leave,
        });
      } catch (err) {
        console.error('[MediaChat] failed to notify leave', err);
      }
    }

    await this.stopScreenShare();

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.microphoneMutedState.set(false);

    for (const peer of this.webRTC.getAllPeers()) {
      this.cleanupPeer(peer.remotePubKey, 'local-stop');
    }

    this.roomSession?.close();
    this.roomSession = null;
    this.started = false;
    this.stopPresenceLoop();
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    this.resetSignalingState();
  }

  public async startScreenShare(): Promise<void> {
    if (!this.started) return;

    try {
      if (this.screenStream) {
        this.log('replacing existing screen share');
        await this.stopScreenShare();
      }

      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      this.screenSharingState.set(true);

      const screenTrack = this.screenStream.getVideoTracks()[0];
      this.log('screen share started');

      for (const peer of this.webRTC.getAllPeers()) {
        peer.peerConnection.addTrack(screenTrack, this.screenStream);
        this.requestOffer(peer.remotePubKey, 'screen-share-start').catch((err) => {
          console.error('[MediaChat] failed to renegotiate screen share start', err);
        });
      }

      screenTrack.addEventListener('ended', () => {
        this.log('local screen share ended by browser');
        this.stopScreenShare().catch((err) => {
          console.error('[MediaChat] failed to stop screen share', err);
        });
      });
    } catch (err) {
      console.error('[MediaChat] failed to open screen share', err);
    }
  }

  public async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;

    this.log('stopping local screen share');

    this.screenStream.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.screenSharingState.set(false);

    for (const peer of this.webRTC.getAllPeers()) {
      const senders = peer.peerConnection.getSenders();
      const videoSenders = senders.filter((sender) => sender.track?.kind == 'video');
      for (const videoSender of videoSenders) {
        peer.peerConnection.removeTrack(videoSender);
      }

      this.requestOffer(peer.remotePubKey, 'screen-share-stop').catch((err) => {
        console.error('[MediaChat] failed to renegotiate screen share stop', err);
      });
    }
  }

  public toggleMicrophone(): void {
    const audioTrack = this.mediaStream?.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;
    this.microphoneMutedState.set(!audioTrack.enabled);
    this.log(audioTrack.enabled ? 'microphone unmuted' : 'microphone muted');
  }

  private async sendChatEvent(
    room: string,
    content: WebRTCNostrEvent,
    targetPubkey?: string,
  ): Promise<void> {
    const payload: WebRTCNostrEvent = {
      ...content,
      nick: content.nick ?? this.credentials?.nick,
      ...(targetPubkey ? { target: targetPubkey } : {}),
    };

    this.log('sending event', {
      type: WebRTCEventType[payload.type],
      target: payload.target ?? 'broadcast',
    });

    await this.nostr.sendEvent(payload, room);
  }

  private async flushPendingIceCandidates(pubkey: string): Promise<void> {
    const pc = this.webRTC.getPeerConnection(pubkey);
    if (!pc?.remoteDescription) return;

    const pendingCandidates = this.pendingIceCandidates[pubkey];
    if (!pendingCandidates?.length) return;

    this.log('flushing pending ICE candidates', {
      pubkey,
      count: pendingCandidates.length,
    });

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

    this.log('creating peer connection', { pubkey, polite: this.isPolitePeer(pubkey) });
    pc = this.webRTC.connectToPeer(pubkey);

    pc.addEventListener('track', (evt) => {
      const track = evt.track;
      const stream = evt.streams[0] ?? new MediaStream([track]);
      this.log('remote track received', {
        pubkey,
        kind: track.kind,
        streamCount: evt.streams.length,
      });

      const peerMedia = this.ensurePeerMedia(pubkey);
      let mediaElement: HTMLAudioElement | HTMLVideoElement;

      if (track.kind == 'audio') {
        mediaElement = peerMedia.audioHtmlElement;
      } else if (track.kind == 'video') {
        peerMedia.screenHtmlElement?.remove();

        const videoElement = document.createElement('video');
        videoElement.playsInline = true;
        videoElement.controls = true;
        videoElement.style.width = '100%';
        peerMedia.screenHtmlElement = videoElement;
        mediaElement = videoElement;
      } else {
        return;
      }

      mediaElement.srcObject = stream;
      mediaElement.autoplay = true;
      void mediaElement.play().catch((err) => {
        this.log('media element play deferred by browser', { pubkey, kind: track.kind, err });
      });

      if (!mediaElement.isConnected) {
        peerMedia.containerHtmlElement.appendChild(mediaElement);
      }

      track.addEventListener('ended', () => {
        this.log('remote track ended', { pubkey, kind: track.kind });
        if (track.kind == 'audio' || track.kind == 'video') {
          this.removePeerTrack(pubkey, track.kind);
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
      this.log('ice connection state changed', {
        pubkey,
        state: pc.iceConnectionState,
      });

      if (
        pc.iceConnectionState == 'disconnected' ||
        pc.iceConnectionState == 'failed' ||
        pc.iceConnectionState == 'closed'
      ) {
        this.cleanupPeer(pubkey, `ice-${pc.iceConnectionState}`);
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      this.log('peer connection state changed', {
        pubkey,
        state: pc.connectionState,
      });

      if (
        pc.connectionState == 'disconnected' ||
        pc.connectionState == 'failed' ||
        pc.connectionState == 'closed'
      ) {
        this.cleanupPeer(pubkey, `connection-${pc.connectionState}`);
        return;
      }
    });

    pc.addEventListener('negotiationneeded', async () => {
      this.log('negotiation needed', {
        pubkey,
        signalingState: pc.signalingState,
      });

      try {
        await this.requestOffer(pubkey, 'negotiationneeded');
      } catch (err) {
        console.error('[MediaChat] negotiation failed', { pubkey, err });
      }
    });

    this.mediaStream?.getTracks().forEach((track) => pc.addTrack(track, this.mediaStream!));
    this.screenStream?.getTracks().forEach((track) => pc.addTrack(track, this.screenStream!));

    return pc;
  }

  private async handleEvent(content: WebRTCNostrEvent, pubkey: string): Promise<void> {
    this.log('received event', {
      from: pubkey,
      type: WebRTCEventType[content.type],
      target: content.target ?? 'broadcast',
    });

    if (content.target && content.target != this.nostr.myPublicKey) return;

    this.peerLastSeenAt[pubkey] = Date.now();

    if (content.nick) {
      this.peerNicks[pubkey] = content.nick;
      this.updatePeerNick(pubkey, content.nick);
    }

    if (content.type == WebRTCEventType.Join) {
      const existingPeer = this.webRTC.getPeerConnection(pubkey);

      if (existingPeer && !this.isPeerHealthy(existingPeer)) {
        this.log('replacing stale peer after join', {
          pubkey,
          connectionState: existingPeer.connectionState,
          iceConnectionState: existingPeer.iceConnectionState,
          signalingState: existingPeer.signalingState,
        });
        this.cleanupPeer(pubkey, 'join-reconnect');
      }

      this.createConnection(pubkey);

      if (!existingPeer || !this.isPeerHealthy(existingPeer)) {
        await this.requestOffer(pubkey, 'join');
      }

      if (!content.target) {
        await this.sendChatEvent(
          this.credentials?.room!,
          {
            type: WebRTCEventType.Join,
          },
          pubkey,
        );
      }

      return;
    }

    if (content.type == WebRTCEventType.Leave) {
      this.cleanupPeer(pubkey, 'remote-leave');
      return;
    }

    if (content.type == WebRTCEventType.Offer) {
      const pc = this.createConnection(pubkey);
      const readyForOffer =
        !this.makingOffer[pubkey] &&
        (pc.signalingState == 'stable' || this.isSettingRemoteAnswerPending[pubkey] === true);
      const offerCollision = !readyForOffer;
      const ignoreOffer = !this.isPolitePeer(pubkey) && offerCollision;

      this.ignoreOffer[pubkey] = ignoreOffer;

      this.log('processing offer', {
        pubkey,
        polite: this.isPolitePeer(pubkey),
        offerCollision,
        ignoreOffer,
        signalingState: pc.signalingState,
      });

      if (ignoreOffer) {
        return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(content.sdp!));
      await this.flushPendingIceCandidates(pubkey);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await this.sendChatEvent(
        this.credentials?.room!,
        {
          type: WebRTCEventType.Answer,
          sdp: pc.localDescription ?? answer,
        },
        pubkey,
      );

      return;
    }

    if (content.type == WebRTCEventType.Answer) {
      const pc = this.webRTC.getPeerConnection(pubkey);
      if (!pc || !content.sdp) return;

      this.isSettingRemoteAnswerPending[pubkey] = true;

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(content.sdp));
        await this.flushPendingIceCandidates(pubkey);
      } finally {
        this.isSettingRemoteAnswerPending[pubkey] = false;
      }

      return;
    }

    if (content.type == WebRTCEventType.IceCandidate) {
      const pc = this.webRTC.getPeerConnection(pubkey) ?? this.createConnection(pubkey);
      if (!content.candidate) return;

      if (!pc.remoteDescription) {
        this.log('queueing ICE candidate until remote description exists', { pubkey });
        this.pendingIceCandidates[pubkey] ??= [];
        this.pendingIceCandidates[pubkey].push(content.candidate);
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(content.candidate));
      } catch (err) {
        if (this.ignoreOffer[pubkey]) {
          this.log('ignored ICE candidate after ignored offer', { pubkey });
          return;
        }

        throw err;
      }
    }
  }

  private ensurePeerMedia(pubkey: string): PeerMedia {
    if (this.peersStreams[pubkey]) {
      return this.peersStreams[pubkey];
    }

    const containerElement = document.createElement('div');
    const nameElement = document.createElement('p');
    const audioElement = document.createElement('audio');
    const nick = this.peerNicks[pubkey] ?? this.formatPeerName(pubkey);

    containerElement.style.margin = '16px 0';
    containerElement.style.padding = '12px';
    containerElement.style.border = '1px solid #d0d7de';
    containerElement.style.borderRadius = '12px';
    containerElement.style.background = '#f6f8fa';

    nameElement.textContent = nick;
    nameElement.style.margin = '0 0 8px';
    nameElement.style.fontWeight = '600';

    audioElement.autoplay = true;
    audioElement.controls = true;

    containerElement.appendChild(nameElement);
    containerElement.appendChild(audioElement);
    document.body.appendChild(containerElement);

    this.peersStreams[pubkey] = {
      mediaStream: null,
      nick,
      containerHtmlElement: containerElement,
      nameHtmlElement: nameElement,
      audioHtmlElement: audioElement,
      screenHtmlElement: null,
    };

    return this.peersStreams[pubkey];
  }

  private removePeerTrack(pubkey: string, kind: 'audio' | 'video'): void {
    const peerMedia = this.peersStreams[pubkey];
    if (!peerMedia) return;

    if (kind == 'video') {
      peerMedia.screenHtmlElement?.remove();
      peerMedia.screenHtmlElement = null;
      if (!peerMedia.audioHtmlElement.isConnected) {
        peerMedia.containerHtmlElement.remove();
        delete this.peersStreams[pubkey];
      }
      return;
    }

    peerMedia.audioHtmlElement.remove();

    if (!peerMedia.screenHtmlElement) {
      peerMedia.containerHtmlElement.remove();
      delete this.peersStreams[pubkey];
      return;
    }

    const replacementAudioElement = document.createElement('audio');
    replacementAudioElement.autoplay = true;
    replacementAudioElement.controls = true;
    peerMedia.containerHtmlElement.appendChild(replacementAudioElement);
    peerMedia.audioHtmlElement = replacementAudioElement;
  }

  private cleanupPeer(pubkey: string, reason: string): void {
    this.log('cleaning peer', { pubkey, reason });

    const peerMedia = this.peersStreams[pubkey];
    peerMedia?.containerHtmlElement.remove();
    peerMedia?.screenHtmlElement?.remove();
    peerMedia?.audioHtmlElement?.remove();
    delete this.peersStreams[pubkey];
    delete this.peerNicks[pubkey];
    delete this.peerLastSeenAt[pubkey];
    delete this.pendingIceCandidates[pubkey];
    delete this.makingOffer[pubkey];
    delete this.ignoreOffer[pubkey];
    delete this.isSettingRemoteAnswerPending[pubkey];

    this.webRTC.closeConnection(pubkey);
  }

  private resetSignalingState(): void {
    for (const key of Object.keys(this.peerLastSeenAt)) {
      delete this.peerLastSeenAt[key];
    }

    for (const key of Object.keys(this.peerNicks)) {
      delete this.peerNicks[key];
    }

    for (const key of Object.keys(this.pendingIceCandidates)) {
      delete this.pendingIceCandidates[key];
    }

    for (const key of Object.keys(this.makingOffer)) {
      delete this.makingOffer[key];
    }

    for (const key of Object.keys(this.ignoreOffer)) {
      delete this.ignoreOffer[key];
    }

    for (const key of Object.keys(this.isSettingRemoteAnswerPending)) {
      delete this.isSettingRemoteAnswerPending[key];
    }
  }

  private isPolitePeer(pubkey: string): boolean {
    return this.nostr.myPublicKey.localeCompare(pubkey) > 0;
  }

  private isPeerHealthy(pc: RTCPeerConnection): boolean {
    if (pc.connectionState == 'connected') {
      return true;
    }

    if (
      pc.connectionState == 'failed' ||
      pc.connectionState == 'disconnected' ||
      pc.connectionState == 'closed'
    ) {
      return false;
    }

    if (
      pc.iceConnectionState == 'failed' ||
      pc.iceConnectionState == 'disconnected' ||
      pc.iceConnectionState == 'closed'
    ) {
      return false;
    }

    if (pc.signalingState == 'closed') {
      return false;
    }

    return true;
  }

  private async requestOffer(pubkey: string, reason: string): Promise<void> {
    const pc = this.webRTC.getPeerConnection(pubkey);
    if (!pc) return;

    if (this.makingOffer[pubkey]) {
      this.log('skipping offer request while another offer is in progress', { pubkey, reason });
      return;
    }

    if (pc.signalingState != 'stable') {
      this.log('skipping offer request because signaling is not stable', {
        pubkey,
        reason,
        signalingState: pc.signalingState,
      });
      return;
    }

    try {
      this.makingOffer[pubkey] = true;
      this.log('creating explicit offer', { pubkey, reason });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await this.sendChatEvent(
        this.credentials?.room!,
        {
          type: WebRTCEventType.Offer,
          sdp: pc.localDescription ?? offer,
        },
        pubkey,
      );
    } finally {
      this.makingOffer[pubkey] = false;
    }
  }

  private updatePeerNick(pubkey: string, nick: string): void {
    const peerMedia = this.peersStreams[pubkey];
    if (!peerMedia) return;

    peerMedia.nick = nick;
    peerMedia.nameHtmlElement.textContent = nick;
  }

  private formatPeerName(pubkey: string): string {
    return `User ${pubkey.slice(0, 8)}`;
  }

  private startPresenceLoop(): void {
    this.stopPresenceLoop();

    this.presenceIntervalId = window.setInterval(() => {
      if (!this.credentials) return;

      this.sendChatEvent(this.credentials.room, {
        type: WebRTCEventType.Join,
      }).catch((err) => {
        console.error('[MediaChat] failed to send presence heartbeat', err);
      });
    }, MediaChat.PRESENCE_INTERVAL_MS);

    this.stalePeersIntervalId = window.setInterval(() => {
      const now = Date.now();

      for (const [pubkey, lastSeenAt] of Object.entries(this.peerLastSeenAt)) {
        if (now - lastSeenAt < MediaChat.STALE_PEER_TIMEOUT_MS) continue;

        this.log('peer timed out from missing presence', {
          pubkey,
          lastSeenAt,
          now,
        });
        this.cleanupPeer(pubkey, 'presence-timeout');
      }
    }, MediaChat.PRESENCE_INTERVAL_MS);
  }

  private stopPresenceLoop(): void {
    if (this.presenceIntervalId !== null) {
      window.clearInterval(this.presenceIntervalId);
      this.presenceIntervalId = null;
    }

    if (this.stalePeersIntervalId !== null) {
      window.clearInterval(this.stalePeersIntervalId);
      this.stalePeersIntervalId = null;
    }
  }

  private log(message: string, context?: unknown): void {
    if (context === undefined) {
      console.debug(`[MediaChat] ${message}`);
      return;
    }

    console.debug(`[MediaChat] ${message}`, context);
  }
}
