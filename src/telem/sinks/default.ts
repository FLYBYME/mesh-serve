/**
 * Shared default sink provider for the node process.
 */

import type { Db } from 'mongodb';
import { FileSink } from './file-sink.js';
import { CollectionSink } from './collection-sink.js';
import { CompositeSink } from './composite-sink.js';

let defaultSink: CompositeSink | undefined;

export function getDefaultTelemSink(db?: Db | null): CompositeSink {
    if (!defaultSink) {
        const fileSink = new FileSink();
        const collectionSink = new CollectionSink({ db });
        defaultSink = new CompositeSink(fileSink, collectionSink);
    } else if (db && !defaultSink.collectionSink['db']) {
        defaultSink.collectionSink.setDb(db);
    }
    return defaultSink;
}

export function setDefaultTelemSink(sink: CompositeSink | undefined): void {
    defaultSink = sink;
}
