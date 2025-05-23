import {extend} from '../util/util';

import type Tile from './tile';
import type Painter from '../render/painter';
import type {FeatureState} from '../style-spec/expression/index';

export type FeatureStates = {
    [feature_id: string]: FeatureState;
};

export type LayerFeatureStates = {
    [layer: string]: FeatureStates;
};

/**
 * SourceFeatureState manages the state and pending changes
 * to features in a source, separated by source layer.
 * stateChanges and deletedStates batch all changes to the tile (updates and removes, respectively)
 * between coalesce() events. addFeatureState() and removeFeatureState() also update their counterpart's
 * list of changes, such that coalesce() can apply the proper state changes while agnostic to the order of operations.
 * In deletedStates, all null's denote complete removal of state at that scope
 * @private
*/
class SourceFeatureState {
    state: LayerFeatureStates;
    stateChanges: LayerFeatureStates;
    deletedStates: LayerFeatureStates;

    constructor() {
        this.state = {};
        this.stateChanges = {};
        this.deletedStates = {};
    }

    updateState(sourceLayer: string, featureId: number | string, newState: FeatureState) {
        const feature = String(featureId);
        this.stateChanges[sourceLayer] = this.stateChanges[sourceLayer] || {};
        this.stateChanges[sourceLayer][feature] = this.stateChanges[sourceLayer][feature] || {};
        extend(this.stateChanges[sourceLayer][feature], newState);

        if (this.deletedStates[sourceLayer] === null) {
            this.deletedStates[sourceLayer] = {};
            for (const ft in this.state[sourceLayer]) {
                if (ft !== feature) this.deletedStates[sourceLayer][ft] = null;
            }
        } else {
            const featureDeletionQueued = this.deletedStates[sourceLayer] && this.deletedStates[sourceLayer][feature] === null;
            if (featureDeletionQueued) {
                this.deletedStates[sourceLayer][feature] = {};
                for (const prop in this.state[sourceLayer][feature]) {
                    if (!newState[prop]) this.deletedStates[sourceLayer][feature][prop] = null;
                }
            } else {
                for (const key in newState) {
                    const deletionInQueue = this.deletedStates[sourceLayer] && this.deletedStates[sourceLayer][feature] && this.deletedStates[sourceLayer][feature][key] === null;
                    if (deletionInQueue) delete this.deletedStates[sourceLayer][feature][key];
                }
            }
        }
    }

    removeFeatureState(sourceLayer: string, featureId?: number | string, key?: string) {
        const sourceLayerDeleted = this.deletedStates[sourceLayer] === null;
        if (sourceLayerDeleted) return;

        const feature = String(featureId);

        this.deletedStates[sourceLayer] = this.deletedStates[sourceLayer] || {};

        if (key && featureId !== undefined) {
            if (this.deletedStates[sourceLayer][feature] !== null) {
                this.deletedStates[sourceLayer][feature] = this.deletedStates[sourceLayer][feature] || {};
                this.deletedStates[sourceLayer][feature][key] = null;
            }
        } else if (featureId !== undefined) {
            const updateInQueue = this.stateChanges[sourceLayer] && this.stateChanges[sourceLayer][feature];
            if (updateInQueue) {
                this.deletedStates[sourceLayer][feature] = {};
                for (key in this.stateChanges[sourceLayer][feature]) this.deletedStates[sourceLayer][feature][key] = null;

            } else {
                this.deletedStates[sourceLayer][feature] = null;
            }
        } else {
            this.deletedStates[sourceLayer] = null;
        }
    }

    getState(sourceLayer: string): FeatureStates;
    getState(sourceLayer: string, featureId: number | string): FeatureState;
    getState(sourceLayer: string, featureId?: number | string): FeatureState | FeatureStates {
        const base = this.state[sourceLayer] || {};
        const changes = this.stateChanges[sourceLayer] || {};
        const deletedStates = this.deletedStates[sourceLayer];
        // return empty object if the whole source layer is awaiting deletion
        if (deletedStates === null) return {};

        if (featureId !== undefined) {
            const feature = String(featureId);
            const reconciledState = extend({}, base[feature], changes[feature]);

            if (deletedStates) {
                const featureDeletions = deletedStates[featureId];
                if (featureDeletions === null) return {};
                for (const prop in featureDeletions) delete reconciledState[prop];
            }

            return reconciledState;
        }

        const reconciledState = extend({}, base, changes);
        if (deletedStates) {
            for (const feature in deletedStates) delete reconciledState[feature];
        }

        return reconciledState;
    }

    initializeTileState(tile: Tile, painter?: Painter | null) {
        tile.refreshFeatureState(painter);
    }

    coalesceChanges(tiles: Record<string | number, Tile>, painter: Painter) {
        //track changes with full state objects, but only for features that got modified
        const featuresChanged: LayerFeatureStates = {};

        for (const sourceLayer in this.stateChanges) {
            this.state[sourceLayer] = this.state[sourceLayer] || {};
            const layerStates: Record<string, FeatureState> = {};
            for (const feature in this.stateChanges[sourceLayer]) {
                if (!this.state[sourceLayer][feature]) this.state[sourceLayer][feature] = {};
                extend(this.state[sourceLayer][feature], this.stateChanges[sourceLayer][feature]);
                layerStates[feature] = this.state[sourceLayer][feature];
            }
            featuresChanged[sourceLayer] = layerStates;
        }

        for (const sourceLayer in this.deletedStates) {
            this.state[sourceLayer] = this.state[sourceLayer] || {};
            const layerStates: Record<string, FeatureState> = {};

            if (this.deletedStates[sourceLayer] === null) {
                for (const ft in this.state[sourceLayer]) {
                    layerStates[ft] = {};
                    this.state[sourceLayer][ft] = {};
                }
            } else {
                for (const feature in this.deletedStates[sourceLayer]) {
                    const deleteWholeFeatureState = this.deletedStates[sourceLayer][feature] === null;
                    if (deleteWholeFeatureState) this.state[sourceLayer][feature] = {};
                    else if (this.state[sourceLayer][feature]) {
                        for (const key of Object.keys(this.deletedStates[sourceLayer][feature])) {
                            delete this.state[sourceLayer][feature][key];
                        }
                    }
                    layerStates[feature] = this.state[sourceLayer][feature];
                }
            }

            featuresChanged[sourceLayer] = featuresChanged[sourceLayer] || {};
            extend(featuresChanged[sourceLayer], layerStates);
        }

        this.stateChanges = {};
        this.deletedStates = {};

        if (Object.keys(featuresChanged).length === 0) return;

        for (const id in tiles) {
            const tile = tiles[id];
            tile.refreshFeatureState(painter);
        }
    }
}

export default SourceFeatureState;
