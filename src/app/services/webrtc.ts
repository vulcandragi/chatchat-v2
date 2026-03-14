import { Injectable } from '@angular/core';
import { WebRTCPeer } from '../dtos';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.mit.de:3478' },
    {
      urls: 'turn:turn.cloudflare.com:3478?transport=udp',
      username: 'g07b6f18441d42dbff399b3c1838ad42e2aedd700312ef49dfd93be72167a94d',
      credential: '7d12f99cbe355facb61418a8dd54517ed9f1f9bd4ac03bae7ae9d8c3dfc1f48c',
    },
  ],
};

@Injectable({
  providedIn: 'root',
})
export class WebRTC {
  private readonly peers: Record<string, RTCPeerConnection> = {};

  public connectToPeer(remotePubKey: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers[remotePubKey] = pc;

    return pc;
  }

  public getPeerConnection(remotePubKey: string): RTCPeerConnection | null {
    return this.peers[remotePubKey];
  }

  public removeConnection(remotePubKey: string): void {
    delete this.peers[remotePubKey];
  }

  public closeConnection(remotePubKey: string): void {
    const pc = this.peers[remotePubKey];
    if (!pc) return;

    if (pc.signalingState !== 'closed') {
      pc.close();
    }

    delete this.peers[remotePubKey];
  }

  public closeAllConnections(): void {
    for (const remotePubKey of Object.keys(this.peers)) {
      this.closeConnection(remotePubKey);
    }
  }

  public getAllPeers(): WebRTCPeer[] {
    return Object.entries(this.peers).map(
      ([key, value]) =>
        ({
          peerConnection: value,
          remotePubKey: key,
        }) as WebRTCPeer,
    );
  }
}
