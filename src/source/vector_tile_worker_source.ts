import {VectorTile} from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import WorkerTile from './worker_tile';
import {extend} from '../util/util';
import {getPerformanceMeasurement} from '../util/performance';
import {Evented} from '../util/evented';
import tileTransform from '../geo/projection/tile_transform';
import {loadVectorTile, DedupedRequest} from './load_vector_tile';

import type {
    WorkerSource,
    WorkerSourceTileRequest,
    WorkerSourceVectorTileRequest,
    WorkerSourceVectorTileResult,
    WorkerSourceVectorTileCallback,
} from './worker_source';
import type Actor from '../util/actor';
import type StyleLayerIndex from '../style/style_layer_index';
import type Scheduler from '../util/scheduler';
import type {TaskMetadata} from '../util/scheduler';
import type {LoadVectorData} from './load_vector_tile';
import type {ImageId} from '../style-spec/expression/types/image_id';
import type {StyleModelMap} from '../style/style_mode';

/**
 * The {@link WorkerSource} implementation that supports {@link VectorTileSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory VectorTile
 * representation.  To do so, create it with
 * `new VectorTileWorkerSource(actor, styleLayers, customLoadVectorDataFunction)`.
 *
 * @private
 */
class VectorTileWorkerSource extends Evented implements WorkerSource {
    actor: Actor;
    layerIndex: StyleLayerIndex;
    availableImages: ImageId[];
    availableModels: StyleModelMap;
    loadVectorData: LoadVectorData;
    loading: Record<number, WorkerTile>;
    loaded: Record<number, WorkerTile>;
    deduped: DedupedRequest;
    isSpriteLoaded: boolean;
    scheduler?: Scheduler | null;
    brightness?: number | null;

    /**
     * @param [loadVectorData] Optional method for custom loading of a VectorTile
     * object based on parameters passed from the main-thread Source. See
     * {@link VectorTileWorkerSource#loadTile}. The default implementation simply
     * loads the pbf at `params.url`.
     * @private
     */
    constructor(actor: Actor, layerIndex: StyleLayerIndex, availableImages: ImageId[], availableModels: StyleModelMap, isSpriteLoaded: boolean, loadVectorData?: LoadVectorData | null, brightness?: number | null) {
        super();
        this.actor = actor;
        this.layerIndex = layerIndex;
        this.availableImages = availableImages;
        this.availableModels = availableModels;
        this.loadVectorData = loadVectorData || loadVectorTile;
        this.loading = {};
        this.loaded = {};
        this.deduped = new DedupedRequest(actor.scheduler);
        this.isSpriteLoaded = isSpriteLoaded;
        this.scheduler = actor.scheduler;
        this.brightness = brightness;
    }

    /**
     * Implements {@link WorkerSource#loadTile}. Delegates to
     * {@link VectorTileWorkerSource#loadVectorData} (which by default expects
     * a `params.url` property) for fetching and producing a VectorTile object.
     * @private
     */
    loadTile(params: WorkerSourceVectorTileRequest, callback: WorkerSourceVectorTileCallback) {
        const uid = params.uid;

        const requestParam = params && params.request;
        const perf = requestParam && requestParam.collectResourceTiming;

        const workerTile = this.loading[uid] = new WorkerTile(params);
        workerTile.abort = this.loadVectorData(params, (err, response) => {
            const aborted = !this.loading[uid];

            delete this.loading[uid];

            workerTile.cancelRasterize();

            if (aborted || err || !response) {
                workerTile.status = 'done';
                if (!aborted) this.loaded[uid] = workerTile;
                return callback(err);
            }

            const rawTileData = response.rawData;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cacheControl: Record<string, any> = {};
            if (response.expires) cacheControl.expires = response.expires;
            if (response.cacheControl) cacheControl.cacheControl = response.cacheControl;

            // response.vectorTile will be present in the GeoJSON worker case (which inherits from this class)
            // because we stub the vector tile interface around JSON data instead of parsing it directly
            workerTile.vectorTile = response.vectorTile || new VectorTile(new Protobuf(rawTileData));
            const parseTile = () => {
                const WorkerSourceVectorTileCallback = (err?: Error | null, result?: WorkerSourceVectorTileResult | null) => {
                    if (err || !result) return callback(err);

                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const resourceTiming: Record<string, any> = {};
                    if (perf) {
                        // Transferring a copy of rawTileData because the worker needs to retain its copy.
                        const resourceTimingData = getPerformanceMeasurement(requestParam);
                        // it's necessary to eval the result of getEntriesByName() here via parse/stringify
                        // late evaluation in the main thread causes TypeError: illegal invocation
                        if (resourceTimingData.length > 0) {
                            resourceTiming.resourceTiming = JSON.parse(JSON.stringify(resourceTimingData));
                        }
                    }
                    callback(null, extend({rawTileData: rawTileData.slice(0)}, result, cacheControl, resourceTiming));
                };
                workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.availableModels, this.actor, WorkerSourceVectorTileCallback);
            };

            if (this.isSpriteLoaded) {
                parseTile();
            } else {
                // Defer tile parsing until sprite is ready. Style emits 'spriteLoaded' event, which triggers the 'isSpriteLoaded' event here.
                this.once('isSpriteLoaded', () => {
                    if (this.scheduler) {
                        const metadata: TaskMetadata = {type: 'parseTile', isSymbolTile: params.isSymbolTile, zoom: params.tileZoom};
                        this.scheduler.add(parseTile, metadata);
                    } else {
                        parseTile();
                    }
                });
            }

            this.loaded = this.loaded || {};
            this.loaded[uid] = workerTile;
        });
    }

    /**
     * Implements {@link WorkerSource#reloadTile}.
     * @private
     */
    reloadTile(params: WorkerSourceVectorTileRequest, callback: WorkerSourceVectorTileCallback) {
        const loaded = this.loaded,
            uid = params.uid;

        if (loaded && loaded[uid]) {
            const workerTile = loaded[uid];
            workerTile.scaleFactor = params.scaleFactor;
            workerTile.showCollisionBoxes = params.showCollisionBoxes;
            workerTile.projection = params.projection;
            workerTile.brightness = params.brightness;
            workerTile.tileTransform = tileTransform(params.tileID.canonical, params.projection);
            workerTile.extraShadowCaster = params.extraShadowCaster;
            workerTile.lut = params.lut;
            workerTile.worldview = params.worldview;
            const done = (err?: Error | null, data?: WorkerSourceVectorTileResult | null) => {
                const reloadCallback = workerTile.reloadCallback;
                if (reloadCallback) {
                    delete workerTile.reloadCallback;
                    workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.availableModels, this.actor, reloadCallback);
                }
                callback(err, data);
            };

            if (workerTile.status === 'parsing') {
                workerTile.reloadCallback = done;
            } else if (workerTile.status === 'done') {
                // if there was no vector tile data on the initial load, don't try and re-parse tile
                if (workerTile.vectorTile) {
                    workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.availableModels, this.actor, done);
                } else {
                    done();
                }
            }
        } else {
            callback(null, undefined);
        }
    }

    /**
     * Implements {@link WorkerSource#abortTile}.
     * @private
     */
    abortTile(params: WorkerSourceTileRequest, callback: WorkerSourceVectorTileCallback) {
        const uid = params.uid;
        const tile = this.loading[uid];
        if (tile) {
            if (tile.abort) tile.abort();
            delete this.loading[uid];
        }
        callback();
    }

    /**
     * Implements {@link WorkerSource#removeTile}.
     * @private
     */
    removeTile(params: WorkerSourceTileRequest, callback: WorkerSourceVectorTileCallback) {
        const loaded = this.loaded,
            uid = params.uid;
        if (loaded && loaded[uid]) {
            delete loaded[uid];
        }
        callback();
    }
}

export default VectorTileWorkerSource;
