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
}

export interface WebRTCNostrEvent {
  type: WebRTCEventType;
  candidate?: RTCIceCandidateInit;
  sdp?: RTCSessionDescriptionInit;
  target?: string;
  nick?: string;
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
