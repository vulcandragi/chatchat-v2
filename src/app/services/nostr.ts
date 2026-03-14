import { Injectable } from '@angular/core';
import { getPublicKey, SimplePool, generateSecretKey } from '@nostr/tools';
import { NostrCredentials, NostrRoomSession } from '../dtos';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Subject } from 'rxjs';
import { NostrEvent } from '@nostr/tools';
import { finalizeEvent } from '@nostr/tools';

const NOSTR_KEYS_LOCALSTORAGE: string = 'nostr_keys';
const NOSTR_DEFAULT_RELAY_POOL: readonly string[] = [
  'wss://temp.iris.to',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

const NOSTR_EVENTS_KIND: number = 21000;
const NOSTR_CHAT_TAG: string = 'chatchatv2_events';

@Injectable({
  providedIn: 'root',
})
export class Nostr {
  private readonly nostrKeys: NostrCredentials<Uint8Array>;
  private readonly pool: SimplePool;

  constructor() {
    this.pool = new SimplePool();

    const localStorageNostrKeys = localStorage.getItem(NOSTR_KEYS_LOCALSTORAGE);
    if (!localStorageNostrKeys) {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      this.nostrKeys = {
        secreteKey: sk,
        publicKey: pk,
      };

      const storageNostrKeys: NostrCredentials<string> = {
        secreteKey: bytesToHex(sk),
        publicKey: pk,
      };

      localStorage.setItem(NOSTR_KEYS_LOCALSTORAGE, JSON.stringify(storageNostrKeys));

      return;
    }

    const storageNostrKeys: NostrCredentials<string> = JSON.parse(localStorageNostrKeys);
    this.nostrKeys = {
      publicKey: storageNostrKeys.publicKey,
      secreteKey: hexToBytes(storageNostrKeys.secreteKey),
    };
  }

  public initNostr(room: string): NostrRoomSession {
    const subj = new Subject<NostrEvent>();
    const subscription = this.pool.subscribe(
      NOSTR_DEFAULT_RELAY_POOL as string[],
      {
        kinds: [NOSTR_EVENTS_KIND],
        since: Math.floor(Date.now() / 1000),
        '#t': [NOSTR_CHAT_TAG],
        '#r': [room],
      },
      {
        onevent: (evt) => {
          if (evt.pubkey == this.nostrKeys.publicKey) return;
          subj.next(evt);
        },
      },
    );

    return {
      events$: subj,
      close: () => {
        subscription.close();
        subj.complete();
      },
    };
  }

  public async sendEvent(content: unknown, room: string): Promise<void> {
    const event = finalizeEvent(
      {
        kind: NOSTR_EVENTS_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', NOSTR_CHAT_TAG],
          ['r', room],
        ],
        content: JSON.stringify(content),
      },
      this.nostrKeys.secreteKey,
    );

    await Promise.any(this.pool.publish(NOSTR_DEFAULT_RELAY_POOL as string[], event));
  }

  public get myPublicKey(): string {
    return this.nostrKeys.publicKey;
  }
}
