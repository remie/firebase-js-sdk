/**
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Query } from '../../../src/core/query';
import { SnapshotVersion } from '../../../src/core/snapshot_version';
import { TargetId } from '../../../src/core/types';
import { Persistence } from '../../../src/local/persistence';
import { QueryCache } from '../../../src/local/query_cache';
import { QueryData } from '../../../src/local/query_data';
import { DocumentKeySet } from '../../../src/model/collections';
import { DocumentKey } from '../../../src/model/document_key';
import { TargetChange } from '../../../src/remote/remote_event';

/**
 * A wrapper around a QueryCache that automatically creates a
 * transaction around every operation to reduce test boilerplate.
 */
export class TestQueryCache {
  constructor(public persistence: Persistence, public cache: QueryCache) {}

  start(): Promise<void> {
    return this.persistence.runTransaction('start', true, txn =>
      this.cache.start(txn)
    );
  }

  addQueryData(queryData: QueryData): Promise<void> {
    return this.persistence.runTransaction('addQueryData', true, txn => {
      return this.cache.addQueryData(txn, queryData);
    });
  }

  updateQueryData(queryData: QueryData): Promise<void> {
    return this.persistence.runTransaction('updateQueryData', true, txn => {
      return this.cache.updateQueryData(txn, queryData);
    });
  }

  count(): number {
    return this.cache.count;
  }

  removeQueryData(queryData: QueryData): Promise<void> {
    return this.persistence.runTransaction('addQueryData', true, txn => {
      return this.cache.removeQueryData(txn, queryData);
    });
  }

  getQueryData(query: Query): Promise<QueryData | null> {
    return this.persistence.runTransaction('getQueryData', true, txn => {
      return this.cache.getQueryData(txn, query);
    });
  }

  getLastRemoteSnapshotVersion(): SnapshotVersion {
    return this.cache.getLastRemoteSnapshotVersion();
  }

  getHighestTargetId(): TargetId {
    return this.cache.getHighestTargetId();
  }

  getMatchingKeysForTargetId(targetId: TargetId): Promise<DocumentKey[]> {
    return this.persistence
      .runTransaction('getMatchingKeysForTargetId', true, txn => {
        return this.cache.getMatchingKeysForTargetId(txn, targetId);
      })
      .then(keySet => {
        const result: DocumentKey[] = [];
        keySet.forEach(key => result.push(key));
        return result;
      });
  }

  applyTargetChange(targetId: TargetId, change: TargetChange): Promise<void> {
    return this.persistence.runTransaction(
      'removeMatchingKeysForTargetId',
      true,
      txn => this.cache.applyTargetChange(txn, targetId, change)
    );
  }

  containsKey(key: DocumentKey): Promise<boolean> {
    return this.persistence.runTransaction('containsKey', true, txn => {
      return this.cache.containsKey(txn, key);
    });
  }

  setLastRemoteSnapshotVersion(version: SnapshotVersion): Promise<void> {
    return this.persistence.runTransaction(
      'setLastRemoteSnapshotVersion',
      true,
      txn => this.cache.setLastRemoteSnapshotVersion(txn, version)
    );
  }

  getChangedKeysForTargetId(
    targetId: TargetId,
    fromVersion?: SnapshotVersion
  ): Promise<DocumentKeySet> {
    return this.persistence.runTransaction(
      'getChangedKeysForTargetId',
      false,
      txn => this.cache.getChangedKeysForTargetId(txn, targetId, fromVersion)
    );
  }
}
