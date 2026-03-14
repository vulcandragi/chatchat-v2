import { computed, inject, Injectable, signal } from '@angular/core';
import { NostrEvent } from '@nostr/tools';
import { Nostr } from './nostr';
import { WebRTC } from './webrtc';
import {
  ChatCredentials,
  KnownPeer,
  NostrRoomSession,
  PeerMedia,
  PeerSessionInfo,
  WebRTCEventType,
  WebRTCNostrEvent,
} from '../dtos';

interface PeerState {
  media: PeerMedia | null;
  session: PeerSessionInfo | null;
  pendingIceCandidates: RTCIceCandidateInit[];
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class MediaChat {
  private readonly nostr = inject(Nostr);
  private readonly webRTC = inject(WebRTC);
  private readonly screenSharingState = signal(false);
  private readonly microphoneMutedState = signal(false);

  private mediaStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private credentials: ChatCredentials | null = null;
  private roomSession: NostrRoomSession | null = null;
  private localSessionId: string | null = null;
  private localSessionStartedAt: number | null = null;
  private started = false;
  private readonly peers: Record<string, PeerState> = {};

  private readonly beforeUnloadHandler = (): void => {
    this.stop(false).catch((err) => {
      console.error('[MediaChat] stop on unload failed', err);
    });
  };

  public readonly isScreenSharing = computed(() => this.screenSharingState());
  public readonly isMicrophoneMuted = computed(() => this.microphoneMutedState());

  public init(credentials: ChatCredentials): void {
    this.credentials = credentials;
    this.log('initialized credentials', credentials);
  }

  public get isInitialized(): boolean {
    return Boolean(this.credentials);
  }

  public async start(): Promise<void> {
    if (!this.isInitialized) throw Error('Chat requer ser configurado antes de ser iniciado.');

    if (this.started) {
      await this.stop();
    }

    this.localSessionId = crypto.randomUUID();
    this.localSessionStartedAt = Date.now();
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

    this.started = true;
    window.addEventListener('beforeunload', this.beforeUnloadHandler);

    await this.sendChatEvent(this.credentials!.room, {
      type: WebRTCEventType.Join,
    });
  }

  public async stop(notifyPeers: boolean = true): Promise<void> {
    if (!this.started && !this.mediaStream && !this.roomSession) return;

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
      this.webRTC.closeConnection(peer.remotePubKey);
    }

    this.roomSession?.close();
    this.roomSession = null;
    this.localSessionId = null;
    this.localSessionStartedAt = null;
    this.started = false;
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);

    this.clearAllPeers();
  }

  public async startScreenShare(): Promise<void> {
    if (!this.started) return;

    try {
      if (this.screenStream) {
        await this.stopScreenShare();
      }

      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      this.screenSharingState.set(true);

      const screenTrack = this.screenStream.getVideoTracks()[0];
      for (const peer of this.webRTC.getAllPeers()) {
        peer.peerConnection.addTrack(screenTrack, this.screenStream);
        this.sendOffer(peer.remotePubKey, 'screen-share-start').catch((err) => {
          console.error('[MediaChat] failed to renegotiate screen share start', err);
        });
      }

      screenTrack.addEventListener('ended', () => {
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

    this.screenStream.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.screenSharingState.set(false);

    for (const peer of this.webRTC.getAllPeers()) {
      const videoSenders = peer.peerConnection
        .getSenders()
        .filter((sender) => sender.track?.kind === 'video');

      for (const videoSender of videoSenders) {
        peer.peerConnection.removeTrack(videoSender);
      }

      this.sendOffer(peer.remotePubKey, 'screen-share-stop').catch((err) => {
        console.error('[MediaChat] failed to renegotiate screen share stop', err);
      });
    }
  }

  public toggleMicrophone(): void {
    const audioTrack = this.mediaStream?.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;
    this.microphoneMutedState.set(!audioTrack.enabled);
  }

  public reconnectPeer(pubkey: string): void {
    this.hardReconnectPeer(pubkey).catch((err) => {
      console.error('[MediaChat] manual reconnect failed', { pubkey, err });
    });
  }

  private getPeerState(pubkey: string): PeerState {
    this.peers[pubkey] ??= {
      media: null,
      session: null,
      pendingIceCandidates: [],
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
    };

    return this.peers[pubkey];
  }

  private async sendChatEvent(
    room: string,
    content: WebRTCNostrEvent,
    targetPubkey?: string,
  ): Promise<void> {
    if (!this.localSessionId || !this.localSessionStartedAt) {
      throw new Error('Local session is not initialized.');
    }

    const payload: WebRTCNostrEvent = {
      ...content,
      nick: content.nick ?? this.credentials?.nick,
      sessionId: content.sessionId ?? this.localSessionId,
      sessionStartedAt: content.sessionStartedAt ?? this.localSessionStartedAt,
      ...(targetPubkey ? { target: targetPubkey } : {}),
    };

    this.log('sending event', {
      type: WebRTCEventType[payload.type],
      target: payload.target ?? 'broadcast',
      sessionId: payload.sessionId,
    });

    await this.nostr.sendEvent(payload, room);
  }

  private createConnection(pubkey: string): RTCPeerConnection {
    const existingConnection = this.webRTC.getPeerConnection(pubkey);
    if (existingConnection) {
      return existingConnection;
    }

    const pc = this.webRTC.connectToPeer(pubkey);
    this.log('creating peer connection', { pubkey, polite: this.isPolitePeer(pubkey) });

    pc.addEventListener('track', (evt) => {
      const track = evt.track;
      const stream = evt.streams[0] ?? new MediaStream([track]);
      const peerMedia = this.ensurePeerMedia(pubkey);

      this.setPeerConnected(pubkey, true);

      if (track.kind === 'audio') {
        peerMedia.audioHtmlElement.srcObject = stream;
        peerMedia.audioHtmlElement.autoplay = true;
        void peerMedia.audioHtmlElement.play().catch(() => undefined);
      }

      if (track.kind === 'video') {
        peerMedia.screenHtmlElement?.remove();

        const videoElement = document.createElement('video');
        videoElement.playsInline = true;
        videoElement.controls = true;
        videoElement.style.width = '100%';
        videoElement.srcObject = stream;
        videoElement.autoplay = true;
        peerMedia.screenHtmlElement = videoElement;
        peerMedia.containerHtmlElement.appendChild(videoElement);

        void videoElement.play().catch(() => undefined);
      }

      track.addEventListener('ended', () => {
        if (track.kind === 'video') {
          this.removeRemoteVideo(pubkey);
        }

        if (track.kind === 'audio') {
          this.resetRemoteAudio(pubkey);
        }

        if (!this.hasRemoteMedia(pubkey)) {
          this.setPeerConnected(pubkey, false);
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
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        this.markPeerDisconnected(pubkey, true, 'ice-failed');
        return;
      }

      if (pc.iceConnectionState === 'disconnected') {
        this.markPeerDisconnected(pubkey, false, 'ice-disconnected');
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        this.setPeerConnected(pubkey, true);
        return;
      }

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.markPeerDisconnected(pubkey, true, 'connection-failed');
        return;
      }

      if (pc.connectionState === 'disconnected') {
        this.markPeerDisconnected(pubkey, false, 'connection-disconnected');
      }
    });

    pc.addEventListener('negotiationneeded', async () => {
      await this.sendOffer(pubkey, 'negotiationneeded');
    });

    this.attachLocalTracks(pc);
    return pc;
  }

  private attachLocalTracks(pc: RTCPeerConnection): void {
    this.mediaStream?.getTracks().forEach((track) => pc.addTrack(track, this.mediaStream!));
    this.screenStream?.getTracks().forEach((track) => pc.addTrack(track, this.screenStream!));
  }

  private async handleEvent(content: WebRTCNostrEvent, pubkey: string): Promise<void> {
    if (content.target && content.target !== this.nostr.myPublicKey) return;
    if (!this.acceptPeerEvent(pubkey, content)) return;

    const peer = this.getPeerState(pubkey);

    if (content.nick) {
      this.updatePeerNick(pubkey, content.nick);
    }

    if (content.type === WebRTCEventType.Join) {
      this.createConnection(pubkey);

      if (!content.target) {
        await this.sendChatEvent(
          this.credentials?.room!,
          {
            type: WebRTCEventType.Join,
          },
          pubkey,
        );

        await this.sendChatEvent(
          this.credentials?.room!,
          {
            type: WebRTCEventType.Peers,
            peers: this.getKnownPeers(pubkey),
          },
          pubkey,
        );
      }

      await this.sendOffer(pubkey, 'join');
      return;
    }

    if (content.type === WebRTCEventType.Peers) {
      for (const knownPeer of content.peers ?? []) {
        await this.discoverPeer(knownPeer);
      }

      return;
    }

    if (content.type === WebRTCEventType.Leave) {
      this.removePeer(pubkey, true);
      return;
    }

    if (content.type === WebRTCEventType.Offer) {
      const pc = this.createConnection(pubkey);
      const readyForOffer =
        !peer.makingOffer && (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
      const offerCollision = !readyForOffer;

      peer.ignoreOffer = !this.isPolitePeer(pubkey) && offerCollision;
      if (peer.ignoreOffer) return;

      await pc.setRemoteDescription(new RTCSessionDescription(content.sdp!));
      await this.flushPendingIce(pubkey);

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

    if (content.type === WebRTCEventType.Answer) {
      const pc = this.webRTC.getPeerConnection(pubkey);
      if (!pc || !content.sdp) return;

      peer.isSettingRemoteAnswerPending = true;

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(content.sdp));
        await this.flushPendingIce(pubkey);
      } finally {
        peer.isSettingRemoteAnswerPending = false;
      }

      return;
    }

    if (content.type === WebRTCEventType.IceCandidate) {
      const pc = this.webRTC.getPeerConnection(pubkey) ?? this.createConnection(pubkey);
      if (!content.candidate) return;

      if (!pc.remoteDescription) {
        peer.pendingIceCandidates.push(content.candidate);
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(content.candidate));
      } catch (err) {
        if (!peer.ignoreOffer) {
          throw err;
        }
      }
    }
  }

  private async flushPendingIce(pubkey: string): Promise<void> {
    const peer = this.getPeerState(pubkey);
    const pc = this.webRTC.getPeerConnection(pubkey);
    if (!pc?.remoteDescription || !peer.pendingIceCandidates.length) return;

    for (const candidate of peer.pendingIceCandidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    peer.pendingIceCandidates = [];
  }

  private async sendOffer(pubkey: string, reason: string): Promise<void> {
    const pc = this.webRTC.getPeerConnection(pubkey);
    if (!pc) return;

    const peer = this.getPeerState(pubkey);
    if (peer.makingOffer) return;
    if (pc.signalingState !== 'stable') return;

    try {
      peer.makingOffer = true;
      this.log('creating offer', { pubkey, reason });

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
      peer.makingOffer = false;
    }
  }

  private async hardReconnectPeer(pubkey: string): Promise<void> {
    await this.sendChatEvent(
      this.credentials?.room!,
      {
        type: WebRTCEventType.Leave,
      },
      pubkey,
    );

    this.removePeer(pubkey, false);
    this.createConnection(pubkey);

    await this.sendChatEvent(
      this.credentials?.room!,
      {
        type: WebRTCEventType.Join,
      },
      pubkey,
    );
    await this.sendOffer(pubkey, 'manual-reconnect');
  }

  private async discoverPeer(peer: KnownPeer): Promise<void> {
    if (peer.pubkey === this.nostr.myPublicKey) return;

    const state = this.getPeerState(peer.pubkey);
    state.session = {
      sessionId: peer.sessionId,
      sessionStartedAt: peer.sessionStartedAt,
    };

    if (peer.nick) {
      this.updatePeerNick(peer.pubkey, peer.nick);
    }

    this.ensurePeerMedia(peer.pubkey);

    if (!this.webRTC.getPeerConnection(peer.pubkey)) {
      this.createConnection(peer.pubkey);
      await this.sendChatEvent(
        this.credentials?.room!,
        {
          type: WebRTCEventType.Join,
        },
        peer.pubkey,
      );
      await this.sendOffer(peer.pubkey, 'peer-share');
    }
  }

  private acceptPeerEvent(pubkey: string, content: WebRTCNostrEvent): boolean {
    if (!content.sessionId || !content.sessionStartedAt) {
      return false;
    }

    const peer = this.getPeerState(pubkey);
    const incomingSession: PeerSessionInfo = {
      sessionId: content.sessionId,
      sessionStartedAt: content.sessionStartedAt,
    };

    if (!peer.session) {
      peer.session = incomingSession;
      return true;
    }

    if (peer.session.sessionId === incomingSession.sessionId) {
      return true;
    }

    if (incomingSession.sessionStartedAt < peer.session.sessionStartedAt) {
      this.log('ignoring stale session event', {
        pubkey,
        incomingSession,
        knownSession: peer.session,
      });
      return false;
    }

    this.log('switching to newer peer session', {
      pubkey,
      incomingSession,
      knownSession: peer.session,
    });
    this.removePeer(pubkey, false);
    this.getPeerState(pubkey).session = incomingSession;
    return true;
  }

  private ensurePeerMedia(pubkey: string): PeerMedia {
    const peer = this.getPeerState(pubkey);
    if (peer.media) {
      return peer.media;
    }

    const containerElement = document.createElement('div');
    const nameElement = document.createElement('p');
    const nameLabelElement = document.createElement('span');
    const statusElement = document.createElement('span');
    const reconnectButtonElement = document.createElement('button');
    const audioElement = this.createAudioElement();
    const nick = this.formatPeerName(pubkey);

    containerElement.className = 'peer-card';
    nameElement.className = 'peer-card__name';
    statusElement.className = 'peer-card__status';
    nameLabelElement.textContent = nick;

    reconnectButtonElement.type = 'button';
    reconnectButtonElement.textContent = 'Reconectar';
    reconnectButtonElement.className = 'peer-card__reconnect';
    reconnectButtonElement.addEventListener('click', () => {
      this.reconnectPeer(pubkey);
    });

    nameElement.appendChild(nameLabelElement);
    nameElement.appendChild(statusElement);
    containerElement.appendChild(nameElement);
    containerElement.appendChild(reconnectButtonElement);
    containerElement.appendChild(audioElement);
    document.body.appendChild(containerElement);

    peer.media = {
      mediaStream: null,
      nick,
      containerHtmlElement: containerElement,
      nameHtmlElement: nameElement,
      nameLabelHtmlElement: nameLabelElement,
      statusHtmlElement: statusElement,
      reconnectButtonHtmlElement: reconnectButtonElement,
      audioHtmlElement: audioElement,
      screenHtmlElement: null,
    };

    this.setPeerConnected(pubkey, false);
    return peer.media;
  }

  private createAudioElement(): HTMLAudioElement {
    const audioElement = document.createElement('audio');
    audioElement.autoplay = true;
    audioElement.controls = true;
    return audioElement;
  }

  private updatePeerNick(pubkey: string, nick: string): void {
    const media = this.ensurePeerMedia(pubkey);
    media.nick = nick;
    media.nameLabelHtmlElement.textContent = nick;
  }

  private setPeerConnected(pubkey: string, connected: boolean): void {
    const media = this.ensurePeerMedia(pubkey);
    media.statusHtmlElement.textContent = connected ? '' : ' (desconectado)';
  }

  private removeRemoteVideo(pubkey: string): void {
    const media = this.getPeerState(pubkey).media;
    if (!media) return;

    media.screenHtmlElement?.remove();
    media.screenHtmlElement = null;
  }

  private resetRemoteAudio(pubkey: string): void {
    const media = this.getPeerState(pubkey).media;
    if (!media) return;

    media.audioHtmlElement.remove();
    media.audioHtmlElement = this.createAudioElement();
    media.containerHtmlElement.appendChild(media.audioHtmlElement);
  }

  private hasRemoteMedia(pubkey: string): boolean {
    const media = this.getPeerState(pubkey).media;
    if (!media) return false;

    return Boolean(media.audioHtmlElement.srcObject || media.screenHtmlElement?.srcObject);
  }

  private markPeerDisconnected(pubkey: string, resetConnection: boolean, reason: string): void {
    this.log('peer disconnected', { pubkey, reason, resetConnection });
    this.setPeerConnected(pubkey, false);

    if (resetConnection) {
      this.webRTC.closeConnection(pubkey);
    }
  }

  private removePeer(pubkey: string, removeCard: boolean): void {
    this.webRTC.closeConnection(pubkey);

    const peer = this.peers[pubkey];
    if (!peer) return;

    if (removeCard) {
      peer.media?.containerHtmlElement.remove();
      delete this.peers[pubkey];
      return;
    }

    peer.pendingIceCandidates = [];
    peer.makingOffer = false;
    peer.ignoreOffer = false;
    peer.isSettingRemoteAnswerPending = false;
    if (peer.media) {
      peer.media.audioHtmlElement.srcObject = null;
      this.removeRemoteVideo(pubkey);
      this.resetRemoteAudio(pubkey);
      this.setPeerConnected(pubkey, false);
    }
  }

  private getKnownPeers(targetPubkey: string): KnownPeer[] {
    if (!this.localSessionId || !this.localSessionStartedAt) {
      return [];
    }

    const peers: KnownPeer[] = [
      {
        pubkey: this.nostr.myPublicKey,
        nick: this.credentials?.nick,
        sessionId: this.localSessionId,
        sessionStartedAt: this.localSessionStartedAt,
      },
    ];

    for (const [pubkey, peer] of Object.entries(this.peers)) {
      if (pubkey === targetPubkey || !peer.session) continue;

      peers.push({
        pubkey,
        nick: peer.media?.nick,
        sessionId: peer.session.sessionId,
        sessionStartedAt: peer.session.sessionStartedAt,
      });
    }

    return peers;
  }

  private clearAllPeers(): void {
    for (const [pubkey, peer] of Object.entries(this.peers)) {
      peer.media?.containerHtmlElement.remove();
      delete this.peers[pubkey];
    }
  }

  private isPolitePeer(pubkey: string): boolean {
    return this.nostr.myPublicKey.localeCompare(pubkey) > 0;
  }

  private formatPeerName(pubkey: string): string {
    return `User ${pubkey.slice(0, 8)}`;
  }

  private log(message: string, context?: unknown): void {
    if (context === undefined) {
      console.debug(`[MediaChat] ${message}`);
      return;
    }

    console.debug(`[MediaChat] ${message}`, context);
  }
}
