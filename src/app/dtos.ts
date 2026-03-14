import { NostrEvent } from '@nostr/tools';
import { Subject } from 'rxjs';

export interface NostrCredentials<T extends string | Uint8Array> {
  secreteKey: T;
  publicKey: string;
}

export enum WebRTCEventType {
  Join,
  Offer,
  Answer,
  IceCandidate,
  Leave,
  Peers,
}

export interface KnownPeer {
  pubkey: string;
  nick?: string;
  sessionId: string;
  sessionStartedAt: number;
}

export interface PeerSessionInfo {
  sessionId: string;
  sessionStartedAt: number;
}

export interface WebRTCNostrEvent {
  type: WebRTCEventType;
  candidate?: RTCIceCandidateInit;
  sdp?: RTCSessionDescriptionInit;
  target?: string;
  nick?: string;
  peers?: KnownPeer[];
  sessionId?: string;
  sessionStartedAt?: number;
}

export interface ChatCredentials {
  room: string;
  nick: string;
}

export interface PeerMedia {
  mediaStream: MediaStream | null;
  nick: string;
  containerHtmlElement: HTMLDivElement;
  nameHtmlElement: HTMLParagraphElement;
  nameLabelHtmlElement: HTMLSpanElement;
  statusHtmlElement: HTMLSpanElement;
  reconnectButtonHtmlElement: HTMLButtonElement;
  audioHtmlElement: HTMLAudioElement;
  screenHtmlElement: HTMLVideoElement | null;
}

export interface NostrRoomSession {
  close(): void;
  events$: Subject<NostrEvent>;
}

export interface WebRTCPeer {
  remotePubKey: string;
  peerConnection: RTCPeerConnection;
}
