export interface NostrCredentials<T extends string | Uint8Array> {
  secreteKey: T;
  publicKey: string;
}

export enum WebRTCEventType {
  Join,
  Offer,
  Answer,
  IceCandidate,
}

export interface WebRTCNostrEvent {
  type: WebRTCEventType;
  candidate?: RTCIceCandidateInit;
  sdp?: RTCSessionDescriptionInit;
  target?: string;
}

export interface ChatCredentials {
  room: string;
  nick: string;
}

export interface PeerMedia {
  mediaStream: MediaStream;
  audioHtmlElement: HTMLAudioElement;
  screenHtmlElement: HTMLVideoElement | null;
}

export interface WebRTCPeer {
  remotePubKey: string;
  peerConnection: RTCPeerConnection;
}
