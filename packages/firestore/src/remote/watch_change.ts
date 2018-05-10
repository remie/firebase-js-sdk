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

import { SnapshotVersion } from '../core/snapshot_version';
import { ProtoByteString, TargetId } from '../core/types';
import { QueryData, QueryPurpose } from '../local/query_data';
import {
  maybeDocumentMap,
  documentKeySet,
  DocumentKeySet
} from '../model/collections';
import { Document, MaybeDocument, NoDocument } from '../model/document';
import { DocumentKey } from '../model/document_key';
import { emptyByteString } from '../platform/platform';
import { assert, fail } from '../util/assert';
import { FirestoreError } from '../util/error';
import * as objUtils from '../util/obj';
import { ExistenceFilter } from './existence_filter';
import { RemoteEvent, TargetChange } from './remote_event';
import { ChangeType } from '../core/view_snapshot';
import { SortedMap } from '../util/sorted_map';
import { SortedSet } from '../util/sorted_set';
import { primitiveComparator } from '../util/misc';

/**
 * Internal representation of the watcher API protocol buffers.
 */
export type WatchChange =
  | DocumentWatchChange
  | WatchTargetChange
  | ExistenceFilterChange;

/**
 * Represents a changed document and a list of target ids to which this change
 * applies.
 *
 * If document has been deleted NoDocument will be provided.
 */
export class DocumentWatchChange {
  constructor(
    /** The new document applies to all of these targets. */
    public updatedTargetIds: TargetId[],
    /** The new document is removed from all of these targets. */
    public removedTargetIds: TargetId[],
    /** The key of the document for this change. */
    public key: DocumentKey,
    /**
     * The new document or NoDocument if it was deleted. Is null if the
     * document went out of view without the server sending a new document.
     */
    public newDoc: Document | NoDocument | null
  ) {}
}

export class ExistenceFilterChange {
  constructor(
    public targetId: TargetId,
    public existenceFilter: ExistenceFilter
  ) {}
}

export enum WatchTargetChangeState {
  NoChange,
  Added,
  Removed,
  Current,
  Reset
}

export class WatchTargetChange {
  constructor(
    /** What kind of change occurred to the watch target. */
    public state: WatchTargetChangeState,
    /** The target IDs that were added/removed/set. */
    public targetIds: TargetId[],
    /**
     * An opaque, server-assigned token that allows watching a query to be
     * resumed after disconnecting without retransmitting all the data that
     * matches the query. The resume token essentially identifies a point in
     * time from which the server should resume sending results.
     */
    public resumeToken: ProtoByteString = emptyByteString(),
    /** An RPC error indicating why the watch failed. */
    public cause: FirestoreError | null = null
  ) {}
}

/** Tracks the internal state of a Watch target. */
interface TargetState {
  /**
   * The number of pending responses (adds or removes) that we are waiting on.
   * We only consider targets active that have no pending responses.
   */
  pendingResponses: number;

  /** The last resume token sent to us for this target. */
  resumeToken: ProtoByteString;

  /**
   * Whether this target has been marked 'current' (i.e. the watch backend has
   * sent us all changes up to the point at which the target was added).
   */
  current: boolean;

  /** Keeps track of the document changes since the last raised snapshot. */
  snapshotChanges: SortedMap<DocumentKey, ChangeType>;
}

/**
 * A helper class to accumulate watch changes into a RemoteEvent and other
 * target information.
 */
export class WatchChangeAggregator {
  /**
   * @param queryDataCallback A callback that returns the QueryData for active
   * queries. Returns 'null' if the query is no longer active (e.g. the user
   * stopped listening).
   * @param existingKeysCallback A callback that returns the set of document
   * keys that were assigned to the target at the last raised snapshot.
   */
  constructor(
    private queryDataCallback: (targetId: TargetId) => QueryData | null,
    private existingKeysCallback: (targetId: TargetId) => DocumentKeySet
  ) {}

  /** The internal state of all tracked targets. */
  private targetStates: { [targetId: number]: TargetState } = {};

  /** Keeps track of the documents to update since the last raised snapshot. */
  private documentUpdates = maybeDocumentMap();

  /** A mapping of document keys to their set of target IDs. */
  private documentTargetMapping = documentTargetMap();

  /**
   * Processes and adds the DocumentWatchChange to the current set of changes.
   */
  addDocumentChange(docChange: DocumentWatchChange): void {
    for (const targetId of docChange.updatedTargetIds) {
      if (docChange.newDoc instanceof Document) {
        this.addDocument(targetId, docChange.newDoc);
      } else if (docChange.newDoc instanceof NoDocument) {
        this.removeDocument(targetId, docChange.key, docChange.newDoc);
      } else {
        // Remove the document from the target, but don't synthesize a document
        // delete since the document may have been modified to no longer match
        // the target.
        this.removeDocument(targetId, docChange.key);
      }
    }

    for (const targetId of docChange.removedTargetIds) {
      this.removeDocument(targetId, docChange.key);
    }
  }

  /** Processes and adds the WatchTargetChange to the current set of changes. */
  addTargetChange(targetChange: WatchTargetChange): void {
    targetChange.targetIds.forEach(targetId => {
      const targetState = this.ensureTargetState(targetId);
      switch (targetChange.state) {
        case WatchTargetChangeState.NoChange:
          if (this.isActiveTarget(targetId)) {
            // Creating the change above satisfies the semantics of no-change.
            this.updateResumeToken(targetId, targetChange.resumeToken);
          }
          break;
        case WatchTargetChangeState.Added:
          // We need to decrement the number of pending acks needed from watch
          // for this targetId.
          this.recordTargetResponse(targetId);
          if (targetState.pendingResponses === 0) {
            // We have a freshly added target, so we need to reset any state
            // that we had previously. This can happen e.g. when remove and add
            // back a target for existence filter mismatches.
            targetState.current = false;
          }
          this.updateResumeToken(targetId, targetChange.resumeToken);
          break;
        case WatchTargetChangeState.Removed:
          // We need to keep track of removed targets to we can
          // post-filter and remove any target changes.
          // We need to decrement the number of pending acks needed from watch
          // for this targetId.
          this.recordTargetResponse(targetId);
          assert(
            !targetChange.cause,
            'WatchChangeAggregator does not handle errored targets'
          );
          break;
        case WatchTargetChangeState.Current:
          if (this.isActiveTarget(targetId)) {
            targetState.current = true;
            this.updateResumeToken(targetId, targetChange.resumeToken);
          }
          break;
        case WatchTargetChangeState.Reset:
          if (this.isActiveTarget(targetId)) {
            // Overwrite any existing target mapping with a reset
            // mapping. Every subsequent update will modify the reset
            // mapping, not an update mapping.
            this.resetTarget(targetId);
            this.updateResumeToken(targetId, targetChange.resumeToken);
          }
          break;
        default:
          fail('Unknown target watch change state: ' + targetChange.state);
      }
    });
  }

  /** Resets a target after an existence filter mismatch. */
  handleExistenceFilterMismatch(targetId: TargetId): void {
    this.resetTarget(targetId);
  }

  /**
   * Converts the currently accumulated state into a remote event at the
   * provided snapshot version. Resets the accumulated changes before returning.
   */
  createRemoteEvent(snapshotVersion: SnapshotVersion): RemoteEvent {
    const targetChanges: { [targetId: number]: TargetChange } = {};

    objUtils.forEachNumber(this.targetStates, (targetId, targetState) => {
      if (this.isActiveTarget(targetId)) {
        const queryData = this.queryDataCallback(targetId);

        let addedDocuments = documentKeySet();
        let modifiedDocuments = documentKeySet();
        let removedDocuments = documentKeySet();

        if (targetState.snapshotChanges.size !== 0) {
          targetState.snapshotChanges.forEach((key, changeType) => {
            switch (changeType) {
              case ChangeType.Added:
                addedDocuments = addedDocuments.add(key);
                break;
              case ChangeType.Modified:
                modifiedDocuments = modifiedDocuments.add(key);
                break;
              case ChangeType.Removed:
                removedDocuments = removedDocuments.add(key);
                break;
              default:
                fail('Encountered invalid change type: ' + changeType);
            }
          });
        } else if (targetState.current && queryData.query.isDocumentQuery()) {
          // Document queries for document that don't exist produce no results.
          // To update our local cache, we synthesize a document delete. This
          // resolves the limbo state of the document, removing it from
          // limboDocumentRefs.
          //
          // TODO(dimond): Ideally we would have an explicit lookup query
          // instead resulting in an explicit delete message and we could
          // remove this special logic.
          this.addDocument(
            targetId,
            new NoDocument(
              new DocumentKey(queryData.query.path),
              snapshotVersion
            )
          );
        }

        targetChanges[targetId] = {
          current: targetState.current,
          resumeToken: targetState.resumeToken,
          snapshotVersion,
          addedDocuments,
          modifiedDocuments,
          removedDocuments
        };

        targetState.snapshotChanges = snapshotChangesMap();
      }
    });

    let resolvedLimboDocuments = documentKeySet();

    this.documentTargetMapping.forEach((key, targets) => {
      let isLimboTarget = true;

      targets.forEachWhile(targetId => {
        if (this.isActiveTarget(targetId)) {
          const queryData = this.queryDataCallback(targetId);
          if (queryData.purpose !== QueryPurpose.LimboResolution) {
            isLimboTarget = false;
            return false;
          }
        }

        return true;
      });

      if (isLimboTarget) {
        resolvedLimboDocuments = resolvedLimboDocuments.add(key);
      }
    });

    const remoteEvent = {
      snapshotVersion,
      targetChanges,
      resolvedLimboDocuments,
      documentUpdates: this.documentUpdates
    };

    this.documentUpdates = maybeDocumentMap();
    this.documentTargetMapping = documentTargetMap();

    return remoteEvent;
  }

  /**
   * Adds the provided document to the internal list of document updates and
   * its document key to the given target's mapping.
   */
  // Visible for testing.
  addDocument(targetId: TargetId, document: MaybeDocument): void {
    if (!this.isActiveTarget(targetId)) {
      return;
    }

    const changeType = this.hasSyncedDocument(targetId, document.key)
      ? ChangeType.Modified
      : ChangeType.Added;

    const targetState = this.ensureTargetState(targetId);
    targetState.snapshotChanges = targetState.snapshotChanges.insert(
      document.key,
      changeType
    );

    this.documentUpdates = this.documentUpdates.insert(document.key, document);

    this.documentTargetMapping = this.documentTargetMapping.insert(
      document.key,
      this.ensureDocumentTargetMapping(document.key).add(targetId)
    );
  }

  /**
   * Removes the provided document from the internal list of document updates and
   * removes its target mapping. If the document exists and we know that is was
   * removed (rather than modified to no longer match a query), a 'NoDocument'
   * should be provided to also remove the document data.
   */
  removeDocument(
    targetId: TargetId,
    key: DocumentKey,
    removedDocument?: NoDocument
  ): void {
    if (!this.isActiveTarget(targetId)) {
      return;
    }

    const targetState = this.ensureTargetState(targetId);

    if (this.hasSyncedDocument(targetId, key)) {
      targetState.snapshotChanges = targetState.snapshotChanges.insert(
        key,
        ChangeType.Removed
      );
      if (removedDocument) {
        // We only synthesize a delete for known snapshot versions. This
        // allows us to not affect the global state of documents during a target
        // reset (which should only bring a single target back to an
        // unknown snapshot version).
        this.documentUpdates = this.documentUpdates.insert(
          key,
          removedDocument
        );
      }
    } else {
      targetState.snapshotChanges = targetState.snapshotChanges.remove(key);
    }

    this.documentTargetMapping = this.documentTargetMapping.insert(
      key,
      this.ensureDocumentTargetMapping(key).delete(targetId)
    );
  }

  /**
   * Returns the current count of documents in the target. This includes both
   * the number of documents that the LocalStore considers to be part of the
   * target as well as any accumulated changes.
   */
  getCurrentSize(targetId: TargetId): number {
    const targetState = this.ensureTargetState(targetId);

    let currentSize = this.existingKeysCallback(targetId).size;

    targetState.snapshotChanges.forEach((key, changeType) => {
      switch (changeType) {
        case ChangeType.Added:
          ++currentSize;
          break;
        case ChangeType.Modified:
          break;
        case ChangeType.Removed:
          --currentSize;
          break;
        default:
          fail('Encountered invalid change type: ' + changeType);
      }
    });

    return currentSize;
  }

  /**
   * Increment the mapping of how many acks are needed from watch before we can
   * consider the server to be 'in-sync' with the client's active targets.
   */
  recordPendingTargetRequest(targetId: TargetId): void {
    const targetState = this.ensureTargetState(targetId);
    // For each request we get we need to record we need a response for it.
    targetState.pendingResponses += 1;
  }

  private ensureTargetState(targetId: TargetId): TargetState {
    if (!this.targetStates[targetId]) {
      this.targetStates[targetId] = {
        pendingResponses: 0,
        current: false,
        resumeToken: emptyByteString(),
        snapshotChanges: snapshotChangesMap()
      };
    }

    return this.targetStates[targetId];
  }

  private ensureDocumentTargetMapping(key: DocumentKey): SortedSet<TargetId> {
    let targetMapping = this.documentTargetMapping.get(key);

    if (!targetMapping) {
      targetMapping = new SortedSet<TargetId>(primitiveComparator);
      this.documentTargetMapping.insert(key, targetMapping);
    }

    return targetMapping;
  }

  /**
   * Verifies that the user is still interested in this target (by calling
   * `queryDataCallback()`) and that we are not waiting for pending ADDs
   * from watch.
   */
  protected isActiveTarget(targetId: TargetId): boolean {
    const targetState = this.ensureTargetState(targetId);

    return (
      this.queryDataCallback(targetId) != null &&
      targetState.pendingResponses === 0
    );
  }

  /**
   * Resets the initial state of a Watch target to its initial state (e.g. sets
   * 'current' to false, clears the resume token and removes its target mapping
   * from all documents).
   */
  private resetTarget(targetId: TargetId): void {
    delete this.targetStates[targetId];

    // Trigger removal for any documents currently mapped to this target.
    // These removals will be part of the initial snapshot if Watch does not
    // resend these documents.
    const existingKeys = this.existingKeysCallback(targetId);
    existingKeys.forEach(key => {
      this.removeDocument(targetId, key);
    });
  }

  /**
   * Record that we get a watch target add/remove by decrementing the number of
   * pending target responses that we have.
   */
  private recordTargetResponse(targetId: TargetId): void {
    const targetState = this.ensureTargetState(targetId);
    targetState.pendingResponses -= 1;
  }

  /**
   * Applies the resume token to the TargetChange, but only when it has a new
   * value. null and empty resumeTokens are discarded.
   */
  private updateResumeToken(
    targetId: TargetId,
    resumeToken: ProtoByteString
  ): void {
    if (resumeToken.length > 0) {
      const targetState = this.ensureTargetState(targetId);
      targetState.resumeToken = resumeToken;
    }
  }

  /** Returns whether the LocalStore considers the document to be part of the specified target. */
  private hasSyncedDocument(targetId: TargetId, key: DocumentKey): boolean {
    const existingKeys = this.existingKeysCallback(targetId);
    return existingKeys.has(key);
  }
}

function documentTargetMap(): SortedMap<DocumentKey, SortedSet<TargetId>> {
  return new SortedMap<DocumentKey, SortedSet<TargetId>>((left, right) =>
    DocumentKey.comparator(left, right)
  );
}

function snapshotChangesMap(): SortedMap<DocumentKey, ChangeType> {
  return new SortedMap<DocumentKey, ChangeType>((left, right) =>
    DocumentKey.comparator(left, right)
  );
}
