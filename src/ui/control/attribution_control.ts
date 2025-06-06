import * as DOM from '../../util/dom';
import {bindAll} from '../../util/util';
import config from '../../util/config';
import {getHashString} from '../hash';

import type {Map, ControlPosition, IControl} from '../map';
import type {StyleSpecification} from '../../style-spec/types';

export type AttributionControlOptions = {
    compact?: boolean;
    customAttribution?: string | null | undefined | Array<string>;
};

/**
 * An `AttributionControl` control presents the map's [attribution information](https://docs.mapbox.com/help/how-mapbox-works/attribution/).
 * Add this control to a map using {@link Map#addControl}.
 *
 * @implements {IControl}
 * @param {Object} [options]
 * @param {boolean} [options.compact] If `true`, force a compact attribution that shows the full attribution on mouse hover. If `false`, force the full attribution control. The default is a responsive attribution that collapses when the map is less than 640 pixels wide. **Attribution should not be collapsed if it can comfortably fit on the map. `compact` should only be used to modify default attribution when map size makes it impossible to fit [default attribution](https://docs.mapbox.com/help/how-mapbox-works/attribution/) and when the automatic compact resizing for default settings are not sufficient**.
 * @param {string | Array<string>} [options.customAttribution] String or strings to show in addition to any other attributions. You can also set a custom attribution when initializing your map with {@link https://docs.mapbox.com/mapbox-gl-js/api/map/#map-parameters the customAttribution option}.
 * @example
 * const map = new mapboxgl.Map({attributionControl: false})
 *     .addControl(new mapboxgl.AttributionControl({
 *         customAttribution: 'Map design by me'
 *     }));
 */
class AttributionControl implements IControl {
    options: AttributionControlOptions;
    _map: Map;
    _container: HTMLElement;
    _innerContainer: HTMLElement;
    _compactButton: HTMLButtonElement;
    _editLink?: HTMLAnchorElement;
    _attribHTML: string;
    styleId: string;
    styleOwner: string;

    constructor(options: AttributionControlOptions = {}) {
        this.options = options;

        bindAll([
            '_toggleAttribution',
            '_updateEditLink',
            '_updateData',
            '_updateCompact'
        ], this);
    }

    getDefaultPosition(): ControlPosition {
        return 'bottom-right';
    }

    onAdd(map: Map): HTMLElement {
        const compact = this.options && this.options.compact;
        const title = map._getUIString('AttributionControl.ToggleAttribution');

        this._map = map;
        this._container = DOM.create('div', 'mapboxgl-ctrl mapboxgl-ctrl-attrib');
        this._compactButton = DOM.create('button', 'mapboxgl-ctrl-attrib-button', this._container);
        this._compactButton.type = 'button';
        this._compactButton.addEventListener('click', this._toggleAttribution);
        this._compactButton.setAttribute('aria-label', title);

        const buttonIcon = DOM.create('span', `mapboxgl-ctrl-icon`, this._compactButton);
        buttonIcon.setAttribute('aria-hidden', 'true');
        buttonIcon.setAttribute('title', title);

        this._innerContainer = DOM.create('div', 'mapboxgl-ctrl-attrib-inner', this._container);

        if (compact) {
            this._container.classList.add('mapboxgl-compact');
        }

        this._updateAttributions();
        this._updateEditLink();

        this._map.on('styledata', this._updateData);
        this._map.on('sourcedata', this._updateData);
        this._map.on('moveend', this._updateEditLink);

        if (compact === undefined) {
            this._map.on('resize', this._updateCompact);
            this._updateCompact();
        }

        return this._container;
    }

    onRemove() {
        this._container.remove();

        this._map.off('styledata', this._updateData);
        this._map.off('sourcedata', this._updateData);
        this._map.off('moveend', this._updateEditLink);
        this._map.off('resize', this._updateCompact);

        this._map = undefined;
        this._attribHTML = undefined;
    }

    _toggleAttribution() {
        if (this._container.classList.contains('mapboxgl-compact-show')) {
            this._container.classList.remove('mapboxgl-compact-show');
            this._compactButton.setAttribute('aria-expanded', 'false');
        } else {
            this._container.classList.add('mapboxgl-compact-show');
            this._compactButton.setAttribute('aria-expanded', 'true');
        }
    }

    _updateEditLink() {
        let editLink = this._editLink;
        if (!editLink) {
            editLink = this._editLink = (this._container.querySelector('.mapbox-improve-map'));
        }

        const params = [
            {key: 'owner', value: this.styleOwner},
            {key: 'id', value: this.styleId},
            {key: 'access_token', value: this._map._requestManager._customAccessToken || config.ACCESS_TOKEN}
        ];

        if (editLink) {
            const paramString = params.reduce((acc, next, i) => {
                if (next.value) {
                    acc += `${next.key}=${next.value}${i < params.length - 1 ? '&' : ''}`;
                }
                return acc;
            }, `?`);
            editLink.href = `${config.FEEDBACK_URL}/${paramString}#${getHashString(this._map, true)}`;
            editLink.rel = 'noopener nofollow';
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _updateData(e: any) {
        if (e && (e.sourceDataType === 'metadata' || e.sourceDataType === 'visibility' || e.dataType === 'style')) {
            this._updateAttributions();
            this._updateEditLink();
        }
    }

    _updateAttributions() {
        if (!this._map.style) return;
        let attributions: Array<string> = [];

        if (this._map.style.stylesheet) {
            const stylesheet: StyleSpecification & {id?: string; owner?: string} = this._map.style.stylesheet;
            this.styleOwner = stylesheet.owner;
            this.styleId = stylesheet.id;
        }

        const sourceCaches = this._map.style._mergedSourceCaches;
        for (const id in sourceCaches) {
            const sourceCache = sourceCaches[id];
            if (sourceCache.used) {
                const source = sourceCache.getSource();
                if (source.attribution && attributions.indexOf(source.attribution) < 0) {
                    attributions.push(source.attribution);
                }
            }
        }

        // remove any entries that are substrings of another entry.
        // first sort by length so that substrings come first
        attributions.sort((a, b) => a.length - b.length);
        attributions = attributions.filter((attrib, i) => {
            for (let j = i + 1; j < attributions.length; j++) {
                if (attributions[j].indexOf(attrib) >= 0) { return false; }
            }
            return true;
        });

        if (this.options.customAttribution) {
            if (Array.isArray(this.options.customAttribution)) {
                attributions = [...this.options.customAttribution, ...attributions];
            } else {
                attributions.unshift(this.options.customAttribution);
            }
        }

        // check if attribution string is different to minimize DOM changes
        const attribHTML = attributions.join(' | ');
        if (attribHTML === this._attribHTML) return;

        this._attribHTML = attribHTML;

        if (attributions.length) {
            this._innerContainer.innerHTML = attribHTML;
            this._container.classList.remove('mapboxgl-attrib-empty');
        } else {
            this._container.classList.add('mapboxgl-attrib-empty');
        }
        // remove old DOM node from _editLink
        this._editLink = null;
    }

    _updateCompact() {
        if (this._map.getCanvasContainer().offsetWidth <= 640) {
            this._container.classList.add('mapboxgl-compact');
        } else {
            this._container.classList.remove('mapboxgl-compact', 'mapboxgl-compact-show');
        }
    }

}

export default AttributionControl;
