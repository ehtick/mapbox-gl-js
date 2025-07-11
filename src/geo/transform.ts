import LngLat, {LngLatBounds} from './lng_lat';
import MercatorCoordinate, {mercatorXfromLng, mercatorYfromLat, mercatorZfromAltitude, latFromMercatorY, MAX_MERCATOR_LATITUDE, circumferenceAtLatitude} from './mercator_coordinate';
import {getProjection} from './projection/index';
import {tileAABB} from '../geo/projection/tile_transform';
import Point from '@mapbox/point-geometry';
import {wrap, clamp, pick, radToDeg, degToRad, getAABBPointSquareDist, furthestTileCorner, warnOnce, deepEqual, easeIn} from '../util/util';
import {number as interpolate} from '../style-spec/util/interpolate';
import EXTENT from '../style-spec/data/extent';
import {vec4, mat4, mat2, vec3, quat} from 'gl-matrix';
import {FAR_BL, FAR_BR, Frustum, FrustumCorners, NEAR_BL, NEAR_BR, Ray} from '../util/primitives';
import EdgeInsets from './edge_insets';
import {FreeCamera, FreeCameraOptions, orientationFromFrame} from '../ui/free_camera';
import assert from 'assert';
import getProjectionAdjustments, {getProjectionAdjustmentInverted, getScaleAdjustment, getProjectionInterpolationT} from './projection/adjustments';
import {getPixelsToTileUnitsMatrix} from '../source/pixels_to_tile_units';
import {UnwrappedTileID, OverscaledTileID, CanonicalTileID, calculateKey} from '../source/tile_id';
import {
    GLOBE_ZOOM_THRESHOLD_MIN,
    GLOBE_ZOOM_THRESHOLD_MAX,
    GLOBE_SCALE_MATCH_LATITUDE
} from '../geo/projection/globe_constants';
import {
    calculateGlobeMatrix,
    polesInViewport,
    aabbForTileOnGlobe,
} from '../geo/projection/globe_util';
import {projectClamped} from '../symbol/projection';
import {edgeIntersectsBox} from '../util/intersection_tests';

import type {Aabb} from '../util/primitives';
import type Projection from '../geo/projection/projection';
import type {Elevation} from '../terrain/elevation';
import type {PaddingOptions} from './edge_insets';
import type Tile from '../source/tile';
import type {ProjectionSpecification} from '../style-spec/types';
import type {FeatureDistanceData} from '../style-spec/feature_filter/index';

const NUM_WORLD_COPIES = 3;
export const DEFAULT_MIN_ZOOM = 0;
export const DEFAULT_MAX_ZOOM = 25.5;
export const MIN_LOD_PITCH = 60.0;

type RayIntersectionResult = {
    p0: vec4;
    p1: vec4;
    t: number;
};
type ElevationReference = 'sea' | 'ground';
type RootTile = {
    aabb: Aabb;
    fullyVisible: boolean;
    maxZ: number;
    minZ: number;
    shouldSplit?: boolean;
    tileID?: OverscaledTileID;
    wrap: number;
    x: number;
    y: number;
    zoom: number;
};

export const OrthographicPitchTranstionValue = 15;

const lerpMatrix = (out: mat4, a: mat4, b: mat4, value: number) => {
    for (let i = 0; i < 16; i++) {
        out[i] = interpolate(a[i], b[i], value);
    }

    return out;
};

const QuadrantVisibility = {
    None: 0,
    TopLeft: 1,
    TopRight: 2,
    BottomLeft: 4,
    BottomRight: 8,
    All: 15
} as const;

type QuadrantMask = typeof QuadrantVisibility[keyof typeof QuadrantVisibility];

/**
 * A single transform, generally used for a single tile to be
 * scaled, rotated, and zoomed.
 * @private
 */
class Transform {
    tileSize: number;
    tileZoom: number;
    maxBounds: LngLatBounds | null | undefined;

    // 2^zoom (worldSize = tileSize * scale)
    scale: number;

    // Map viewport size (not including the pixel ratio)
    width: number;
    height: number;

    // Bearing, radians, in [-pi, pi]
    angle: number;

    // 2D rotation matrix in the horizontal plane, as a function of bearing
    rotationMatrix: [number, number, number, number];

    // Zoom, modulo 1
    zoomFraction: number;

    // The scale factor component of the conversion from pixels ([0, w] x [h, 0]) to GL
    // NDC ([1, -1] x [1, -1]) (note flipped y)
    pixelsToGLUnits: [number, number];

    // Distance from camera to the center, in screen pixel units, independent of zoom
    cameraToCenterDistance: number;

    // Projection from mercator coordinates ([0, 0] nw, [1, 1] se) to GL clip coordinates
    mercatorMatrix: mat4;

    // Translate points in mercator coordinates to be centered about the camera, with units chosen
    // for screen-height-independent scaling of fog. Not affected by orientation of camera.
    mercatorFogMatrix: mat4;

    // Projection from world coordinates (mercator scaled by worldSize) to clip coordinates
    projMatrix: mat4;
    invProjMatrix: mat4;

    // Projection matrix with expanded farZ on globe projection
    expandedFarZProjMatrix: mat4;

    // Same as projMatrix, pixel-aligned to avoid fractional pixels for raster tiles
    alignedProjMatrix: mat4;

    // From world coordinates to screen pixel coordinates (projMatrix premultiplied by labelPlaneMatrix)
    pixelMatrix: mat4;
    pixelMatrixInverse: mat4;

    worldToFogMatrix: mat4;
    skyboxMatrix: mat4;

    starsProjMatrix: mat4;

    // Transform from screen coordinates to GL NDC, [0, w] x [h, 0] --> [-1, 1] x [-1, 1]
    // Roughly speaking, applies pixelsToGLUnits scaling with a translation
    glCoordMatrix: mat4;

    // Inverse of glCoordMatrix, from NDC to screen coordinates, [-1, 1] x [-1, 1] --> [0, w] x [h, 0]
    labelPlaneMatrix: mat4;

    // globe coordinate transformation matrix
    globeMatrix: mat4;

    globeCenterInViewSpace: [number, number, number];
    globeRadius: number;

    inverseAdjustmentMatrix: mat2;

    mercatorFromTransition: boolean;

    minLng: number;
    maxLng: number;
    minLat: number;
    maxLat: number;
    worldMinX: number;
    worldMaxX: number;
    worldMinY: number;
    worldMaxY: number;

    cameraFrustum: Frustum;
    frustumCorners: FrustumCorners;
    _tileCoverLift: number;

    freezeTileCoverage: boolean;
    cameraElevationReference: ElevationReference;
    fogCullDistSq: number | null | undefined;
    _averageElevation: number;
    projectionOptions: ProjectionSpecification;
    projection: Projection;
    _elevation: Elevation | null | undefined;
    _fov: number;
    _pitch: number;
    _zoom: number;
    _seaLevelZoom: number | null | undefined;
    _unmodified: boolean;
    _renderWorldCopies: boolean;
    _minZoom: number;
    _maxZoom: number;
    _minPitch: number;
    _maxPitch: number;
    _center: LngLat;
    _edgeInsets: EdgeInsets;
    _constraining: boolean;
    _projMatrixCache: {
        [_: number]: mat4;
    };
    _alignedProjMatrixCache: {
        [_: number]: mat4;
    };
    _pixelsToTileUnitsCache: {
        [_: number]: mat2;
    };
    _expandedProjMatrixCache: {
        [_: number]: mat4;
    };
    _fogTileMatrixCache: {
        [_: number]: mat4;
    };
    _distanceTileDataCache: {
        [_: number]: FeatureDistanceData;
    };
    _camera: FreeCamera;
    _centerAltitude: number;
    _centerAltitudeValidForExaggeration: number | null | undefined;
    _horizonShift: number;
    _pixelsPerMercatorPixel: number;
    _nearZ: number;
    _farZ: number;
    _mercatorScaleRatio: number;
    _isCameraConstrained: boolean;

    _orthographicProjectionAtLowPitch: boolean;

    _allowWorldUnderZoom: boolean;

    constructor(minZoom?: number | null, maxZoom?: number | null, minPitch?: number | null, maxPitch?: number | null, renderWorldCopies?: boolean, projection?: ProjectionSpecification | null, bounds?: LngLatBounds | null) {
        this.tileSize = 512; // constant

        this._renderWorldCopies = renderWorldCopies === undefined ? true : renderWorldCopies;
        this._minZoom = minZoom || DEFAULT_MIN_ZOOM;
        this._maxZoom = maxZoom || 22;

        this._minPitch = (minPitch === undefined || minPitch === null) ? 0 : minPitch;
        this._maxPitch = (maxPitch === undefined || maxPitch === null) ? 60 : maxPitch;

        this.setProjection(projection);
        this.setMaxBounds(bounds);

        this.width = 0;
        this.height = 0;
        this._center = new LngLat(0, 0);
        this.zoom = 0;
        this.angle = 0;
        this._fov = 0.6435011087932844;
        this._pitch = 0;
        this._nearZ = 0;
        this._farZ = 0;
        this._unmodified = true;
        this._edgeInsets = new EdgeInsets();
        this._projMatrixCache = {};
        this._alignedProjMatrixCache = {};
        this._fogTileMatrixCache = {};
        this._expandedProjMatrixCache = {};
        this._distanceTileDataCache = {};
        this._camera = new FreeCamera();
        this._centerAltitude = 0;
        this._averageElevation = 0;
        this.cameraElevationReference = "ground";
        this._pixelsPerMercatorPixel = 1.0;
        this.globeRadius = 0;
        this.globeCenterInViewSpace = [0, 0, 0];
        this._tileCoverLift = 0;
        this.freezeTileCoverage = false;

        // Move the horizon closer to the center. 0 would not shift the horizon. 1 would put the horizon at the center.
        this._horizonShift = 0.1;

        this._orthographicProjectionAtLowPitch = false;

        this._allowWorldUnderZoom = false;
    }

    clone(): Transform {
        const clone = new Transform(this._minZoom, this._maxZoom, this._minPitch, this.maxPitch, this._renderWorldCopies, this.getProjection(), this.maxBounds);
        clone._elevation = this._elevation;
        clone._centerAltitude = this._centerAltitude;
        clone._centerAltitudeValidForExaggeration = this._centerAltitudeValidForExaggeration;
        clone.tileSize = this.tileSize;
        clone.mercatorFromTransition = this.mercatorFromTransition;
        clone.width = this.width;
        clone.height = this.height;
        clone.cameraElevationReference = this.cameraElevationReference;
        clone._center = this._center;
        clone._setZoom(this.zoom);
        clone._seaLevelZoom = this._seaLevelZoom;
        clone.angle = this.angle;
        clone._fov = this._fov;
        clone._pitch = this._pitch;
        clone._nearZ = this._nearZ;
        clone._farZ = this._farZ;
        clone._averageElevation = this._averageElevation;
        clone._orthographicProjectionAtLowPitch = this._orthographicProjectionAtLowPitch;
        clone._unmodified = this._unmodified;
        clone._edgeInsets = this._edgeInsets.clone();
        clone._camera = this._camera.clone();
        clone._calcMatrices();
        clone.freezeTileCoverage = this.freezeTileCoverage;
        clone.frustumCorners = this.frustumCorners;
        clone._allowWorldUnderZoom = this._allowWorldUnderZoom;
        return clone;
    }

    get isOrthographic(): boolean {
        return this.projection.name !== 'globe' && this._orthographicProjectionAtLowPitch && this.pitch < OrthographicPitchTranstionValue;
    }
    get elevation(): Elevation | null | undefined { return this._elevation; }
    set elevation(elevation: Elevation | null | undefined) {
        if (this._elevation === elevation) return;
        this._elevation = elevation;
        this._updateCameraOnTerrain();
        this._calcMatrices();
    }
    get depthOcclusionForSymbolsAndCircles(): boolean {
        return this.projection.name !== 'globe' && !this.isOrthographic;
    }

    updateElevation(constrainCameraOverTerrain: boolean, adaptCameraAltitude: boolean = false) {
        const centerAltitudeChanged = this._elevation && this._elevation.exaggeration() !== this._centerAltitudeValidForExaggeration;
        if (this._seaLevelZoom == null || centerAltitudeChanged) {
            this._updateCameraOnTerrain();
        }
        if (constrainCameraOverTerrain || centerAltitudeChanged) {
            this._constrainCamera(adaptCameraAltitude);
        }
        this._calcMatrices();
    }

    getProjection(): ProjectionSpecification {
        return pick(this.projection, ['name', 'center', 'parallels']) as ProjectionSpecification;
    }

    // Returns whether the projection changes
    setProjection(projection?: ProjectionSpecification | null): boolean {
        this.projectionOptions = projection || {name: 'mercator'};

        const oldProjection = this.projection ? this.getProjection() : undefined;
        this.projection = getProjection(this.projectionOptions);
        const newProjection = this.getProjection();

        const projectionHasChanged = !deepEqual(oldProjection, newProjection);
        if (projectionHasChanged) {
            this._calcMatrices();
        }
        this.mercatorFromTransition = false;

        return projectionHasChanged;
    }

    // Returns whether the projection need to be reevaluated
    setOrthographicProjectionAtLowPitch(enabled: boolean): boolean {
        if (this._orthographicProjectionAtLowPitch === enabled) {
            return false;
        }

        this._orthographicProjectionAtLowPitch = enabled;
        this._calcMatrices();

        return true;
    }

    setMercatorFromTransition(): boolean {
        const oldProjection = this.projection.name;
        this.mercatorFromTransition = true;
        this.projectionOptions = {name: 'mercator'};
        this.projection = getProjection({name: 'mercator'});
        const projectionHasChanged = oldProjection !== this.projection.name;
        if (projectionHasChanged) {
            this._calcMatrices();
        }
        return projectionHasChanged;
    }

    get minZoom(): number { return this._minZoom; }
    set minZoom(zoom: number) {
        if (this._minZoom === zoom) return;
        this._minZoom = zoom;
        this.zoom = Math.max(this.zoom, zoom);
    }

    get maxZoom(): number { return this._maxZoom; }
    set maxZoom(zoom: number) {
        if (this._maxZoom === zoom) return;
        this._maxZoom = zoom;
        this.zoom = Math.min(this.zoom, zoom);
    }

    get minPitch(): number { return this._minPitch; }
    set minPitch(pitch: number) {
        if (this._minPitch === pitch) return;
        this._minPitch = pitch;
        this.pitch = Math.max(this.pitch, pitch);
    }

    get maxPitch(): number { return this._maxPitch; }
    set maxPitch(pitch: number) {
        if (this._maxPitch === pitch) return;
        this._maxPitch = pitch;
        this.pitch = Math.min(this.pitch, pitch);
    }

    get renderWorldCopies(): boolean {
        return this._renderWorldCopies && this.projection.supportsWorldCopies === true;
    }
    set renderWorldCopies(renderWorldCopies: boolean | null | undefined) {
        if (renderWorldCopies === undefined) {
            renderWorldCopies = true;
        } else if (renderWorldCopies === null) {
            renderWorldCopies = false;
        }

        this._renderWorldCopies = renderWorldCopies;
    }

    get worldSize(): number {
        return this.tileSize * this.scale;
    }

    // This getter returns an incorrect value.
    // It should eventually be removed and cameraWorldSize be used instead.
    // See free_camera.getDistanceToElevation for the rationale.
    get cameraWorldSizeForFog(): number {
        const distance = Math.max(this._camera.getDistanceToElevation(this._averageElevation), Number.EPSILON);
        return this._worldSizeFromZoom(this._zoomFromMercatorZ(distance));
    }

    get cameraWorldSize(): number {
        const distance = Math.max(this._camera.getDistanceToElevation(this._averageElevation, true), Number.EPSILON);
        return this._worldSizeFromZoom(this._zoomFromMercatorZ(distance));
    }

    // `pixelsPerMeter` is used to describe relation between real world and pixel distances.
    // In mercator projection it is dependant on latitude value meaning that one meter covers
    // less pixels at the equator than near polar regions. Globe projection in other hand uses
    // fixed ratio everywhere.

    get pixelsPerMeter(): number {
        return this.projection.pixelsPerMeter(this.center.lat, this.worldSize);
    }

    get cameraPixelsPerMeter(): number {
        return mercatorZfromAltitude(1, this.center.lat) * this.cameraWorldSizeForFog;
    }

    get centerOffset(): Point {
        return this.centerPoint._sub(this.size._div(2));
    }

    get size(): Point {
        return new Point(this.width, this.height);
    }

    get bearing(): number {
        return wrap(this.rotation, -180, 180);
    }

    set bearing(bearing: number) {
        this.rotation = bearing;
    }

    get rotation(): number {
        return -this.angle / Math.PI * 180;
    }

    set rotation(rotation: number) {
        const b = -rotation * Math.PI / 180;
        if (this.angle === b) return;
        this._unmodified = false;
        this.angle = b;
        this._calcMatrices();

        // 2x2 matrix for rotating points
        this.rotationMatrix = mat2.create() as [number, number, number, number];
        mat2.rotate(this.rotationMatrix, this.rotationMatrix, this.angle);
    }

    get pitch(): number {
        return this._pitch / Math.PI * 180;
    }
    set pitch(pitch: number) {
        const p = clamp(pitch, this.minPitch, this.maxPitch) / 180 * Math.PI;
        if (this._pitch === p) return;
        this._unmodified = false;
        this._pitch = p;
        this._calcMatrices();
    }

    get aspect(): number {
        return this.width / this.height;
    }

    get fov(): number {
        return this._fov / Math.PI * 180;
    }

    set fov(fov: number) {
        fov = Math.max(0.01, Math.min(60, fov));
        if (this._fov === fov) return;
        this._unmodified = false;
        this._fov = degToRad(fov);
        this._calcMatrices();
    }

    get fovX(): number {
        return this._fov;
    }

    get fovY(): number {
        const focalLength = 1.0 / Math.tan(this.fovX * 0.5);
        return 2 * Math.atan((1.0 / this.aspect) / focalLength);
    }

    get averageElevation(): number {
        return this._averageElevation;
    }
    set averageElevation(averageElevation: number) {
        this._averageElevation = averageElevation;
        this._calcFogMatrices();
        this._distanceTileDataCache = {};
    }

    get zoom(): number { return this._zoom; }
    set zoom(zoom: number) {
        const z = Math.min(Math.max(zoom, this.minZoom), this.maxZoom);
        if (this._zoom === z) return;
        this._unmodified = false;
        this._setZoom(z);
        this._updateSeaLevelZoom();
        this._constrain();
        this._calcMatrices();
    }
    _setZoom(z: number) {
        this._zoom = z;
        this.scale = this.zoomScale(z);
        this.tileZoom = Math.floor(z);
        this.zoomFraction = z - this.tileZoom;
    }

    get tileCoverLift(): number { return this._tileCoverLift; }
    set tileCoverLift(lift: number) {
        if (this._tileCoverLift === lift) return;
        this._tileCoverLift = lift;
    }

    _updateCameraOnTerrain() {
        const elevationAtCenter = this.elevation ? this.elevation.getAtPoint(this.locationCoordinate(this.center), Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
        const usePreviousCenter = this.elevation && elevationAtCenter === Number.NEGATIVE_INFINITY && this.elevation.visibleDemTiles.length > 0 && this.elevation.exaggeration() > 0 &&
            this._centerAltitudeValidForExaggeration;
        if (!this._elevation || (elevationAtCenter === Number.NEGATIVE_INFINITY && !(usePreviousCenter && this._centerAltitude))) {
            // Elevation data not loaded yet, reset
            this._centerAltitude = 0;
            this._seaLevelZoom = null;
            this._centerAltitudeValidForExaggeration = undefined;
            return;
        }
        const elevation: Elevation = this._elevation;
        if (usePreviousCenter || (this._centerAltitude && this._centerAltitudeValidForExaggeration &&
                                  elevation.exaggeration() && this._centerAltitudeValidForExaggeration !== elevation.exaggeration())) {
            assert(this._centerAltitudeValidForExaggeration);
            const previousExaggeration = this._centerAltitudeValidForExaggeration;
            // scale down the centerAltitude
            this._centerAltitude = this._centerAltitude / previousExaggeration * elevation.exaggeration();
            this._centerAltitudeValidForExaggeration = elevation.exaggeration();
        } else {
            this._centerAltitude = elevationAtCenter || 0;
            this._centerAltitudeValidForExaggeration = elevation.exaggeration();
        }
        this._updateSeaLevelZoom();
    }

    _updateSeaLevelZoom() {
        if (this._centerAltitudeValidForExaggeration === undefined) {
            return;
        }
        const height = this.cameraToCenterDistance;
        const terrainElevation = this.pixelsPerMeter * this._centerAltitude;
        const mercatorZ = Math.max(0, (terrainElevation + height) / this.worldSize);

        // MSL (Mean Sea Level) zoom describes the distance of the camera to the sea level (altitude).
        // It is used only for manipulating the camera location. The standard zoom (this._zoom)
        // defines the camera distance to the terrain (height). Its behavior and conceptual
        // meaning in determining which tiles to stream is same with or without the terrain.
        this._seaLevelZoom = this._zoomFromMercatorZ(mercatorZ);
    }

    sampleAverageElevation(): number {
        if (!this._elevation) return 0;
        const elevation: Elevation = this._elevation;

        const elevationSamplePoints = [
            [0.5, 0.2],
            [0.3, 0.5],
            [0.5, 0.5],
            [0.7, 0.5],
            [0.5, 0.8]
        ];

        const horizon = this.horizonLineFromTop();

        let elevationSum = 0.0;
        let weightSum = 0.0;
        for (let i = 0; i < elevationSamplePoints.length; i++) {
            const pt = new Point(
                elevationSamplePoints[i][0] * this.width,
                horizon + elevationSamplePoints[i][1] * (this.height - horizon)
            );
            const hit = elevation.pointCoordinate(pt);
            if (!hit) continue;

            const distanceToHit = Math.hypot(hit[0] - this._camera.position[0], hit[1] - this._camera.position[1]);
            const weight = 1 / distanceToHit;
            elevationSum += hit[3] * weight;
            weightSum += weight;
        }

        if (weightSum === 0) return NaN;
        return elevationSum / weightSum;
    }

    get center(): LngLat { return this._center; }
    set center(center: LngLat) {
        if (center.lat === this._center.lat && center.lng === this._center.lng) return;

        this._unmodified = false;
        this._center = center;
        if (this._terrainEnabled()) {
            if (this.cameraElevationReference === "ground") {
                this._updateCameraOnTerrain();
            } else {
                this._updateZoomFromElevation();
            }
        }
        this._constrain();
        this._calcMatrices();
    }

    _updateZoomFromElevation() {
        if (this._seaLevelZoom == null || !this._elevation)
            return;

        // Compute zoom level from the height of the camera relative to the terrain
        const seaLevelZoom: number = this._seaLevelZoom;
        const elevationAtCenter = this._elevation.getAtPointOrZero(this.locationCoordinate(this.center));
        const mercatorElevation = this.pixelsPerMeter / this.worldSize * elevationAtCenter;
        const altitude  = this._mercatorZfromZoom(seaLevelZoom);
        const minHeight = this._mercatorZfromZoom(this._maxZoom);
        const height = Math.max(altitude - mercatorElevation, minHeight);

        this._setZoom(this._zoomFromMercatorZ(height));
    }

    get padding(): PaddingOptions { return this._edgeInsets.toJSON(); }
    set padding(padding: PaddingOptions) {
        if (this._edgeInsets.equals(padding)) return;
        this._unmodified = false;
        //Update edge-insets inplace
        this._edgeInsets.interpolate(this._edgeInsets, padding, 1);
        this._calcMatrices();
    }

    /**
     * Computes a zoom value relative to a map plane that goes through the provided mercator position.
     *
     * @param {MercatorCoordinate} position A position defining the altitude of the the map plane.
     * @returns {number} The zoom value.
     */
    computeZoomRelativeTo(position: MercatorCoordinate): number {
        // Find map center position on the target plane by casting a ray from screen center towards the plane.
        // Direct distance to the target position is used if the target position is above camera position.
        const centerOnTargetAltitude = this.rayIntersectionCoordinate(this.pointRayIntersection(this.centerPoint, position.toAltitude()));

        let targetPosition: vec3 | null | undefined;
        if (position.z < this._camera.position[2]) {
            targetPosition = [centerOnTargetAltitude.x, centerOnTargetAltitude.y, centerOnTargetAltitude.z];
        } else {
            targetPosition = [position.x, position.y, position.z];
        }

        const distToTarget = vec3.length(vec3.sub([] as unknown as vec3, this._camera.position, targetPosition));
        return clamp(this._zoomFromMercatorZ(distToTarget), this._minZoom, this._maxZoom);
    }

    setFreeCameraOptions(options: FreeCameraOptions) {
        if (!this.height)
            return;

        if (!options.position && !options.orientation)
            return;

        // Camera state must be up-to-date before accessing its getters
        this._updateCameraState();

        let changed = false;
        if (options.orientation && !quat.exactEquals(options.orientation, this._camera.orientation)) {
            changed = this._setCameraOrientation(options.orientation);
        }

        if (options.position) {
            const newPosition: [number, number, number] = [options.position.x, options.position.y, options.position.z];
            if (!vec3.exactEquals(newPosition, this._camera.position)) {
                this._setCameraPosition(newPosition);
                changed = true;
            }
        }

        if (changed) {
            this._updateStateFromCamera();
            this.recenterOnTerrain();
        }
    }

    getFreeCameraOptions(): FreeCameraOptions {
        this._updateCameraState();
        const pos = this._camera.position;
        const options = new FreeCameraOptions();
        options.position = new MercatorCoordinate(pos[0], pos[1], pos[2]);
        options.orientation = this._camera.orientation;
        options._elevation = this.elevation;
        options._renderWorldCopies = this.renderWorldCopies;

        return options;
    }

    _setCameraOrientation(orientation: quat): boolean {
        // zero-length quaternions are not valid
        if (!quat.length(orientation))
            return false;

        quat.normalize(orientation, orientation);

        // The new orientation must be sanitized by making sure it can be represented
        // with a pitch and bearing. Roll-component must be removed and the camera can't be upside down
        const forward = vec3.transformQuat([] as unknown as vec3, [0, 0, -1], orientation);
        const up = vec3.transformQuat([] as unknown as vec3, [0, -1, 0], orientation);

        if (up[2] < 0.0)
            return false;

        const updatedOrientation = orientationFromFrame(forward, up);
        if (!updatedOrientation)
            return false;

        this._camera.orientation = updatedOrientation;
        return true;
    }

    _setCameraPosition(position: vec3) {
        // Altitude must be clamped to respect min and max zoom
        const minWorldSize = this.zoomScale(this.minZoom) * this.tileSize;
        const maxWorldSize = this.zoomScale(this.maxZoom) * this.tileSize;
        const distToCenter = this.cameraToCenterDistance;

        position[2] = clamp(position[2], distToCenter / maxWorldSize, distToCenter / minWorldSize);
        this._camera.position = position;
    }

    /**
     * The center of the screen in pixels with the top-left corner being (0,0)
     * and +y axis pointing downwards. This accounts for padding.
     *
     * @readonly
     * @type {Point}
     * @memberof Transform
     */
    get centerPoint(): Point {
        return this._edgeInsets.getCenter(this.width, this.height);
    }

    /**
     * Returns the vertical half-fov, accounting for padding, in radians.
     *
     * @readonly
     * @type {number}
     * @private
     */
    get fovAboveCenter(): number {
        return this._fov * (0.5 + this.centerOffset.y / this.height);
    }

    /**
     * Returns true if the padding options are equal.
     *
     * @param {PaddingOptions} padding The padding options to compare.
     * @returns {boolean} True if the padding options are equal.
     * @memberof Transform
     */
    isPaddingEqual(padding: PaddingOptions): boolean {
        return this._edgeInsets.equals(padding);
    }

    /**
     * Helper method to update edge-insets inplace.
     *
     * @param {PaddingOptions} start The initial padding options.
     * @param {PaddingOptions} target The target padding options.
     * @param {number} t The interpolation variable.
     * @memberof Transform
     */
    interpolatePadding(start: PaddingOptions, target: PaddingOptions, t: number) {
        this._unmodified = false;
        this._edgeInsets.interpolate(start, target, t);
        this._constrain();
        this._calcMatrices();
    }

    /**
     * Return the highest zoom level that fully includes all tiles within the transform's boundaries.
     * @param {Object} options Options.
     * @param {number} options.tileSize Tile size, expressed in screen pixels.
     * @param {boolean} options.roundZoom Target zoom level. If true, the value will be rounded to the closest integer. Otherwise the value will be floored.
     * @returns {number} An integer zoom level at which all tiles will be visible.
     */
    coveringZoomLevel(
        options: {
            roundZoom?: boolean;
            tileSize: number;
        },
    ): number {
        const z = (options.roundZoom ? Math.round : Math.floor)(
            this.zoom + this.scaleZoom(this.tileSize / options.tileSize)
        );
        // At negative zoom levels load tiles from z0 because negative tile zoom levels don't exist.
        return Math.max(0, z);
    }

    /**
     * Return any "wrapped" copies of a given tile coordinate that are visible
     * in the current view.
     *
     * @private
     */
    getVisibleUnwrappedCoordinates(tileID: CanonicalTileID): Array<UnwrappedTileID> {
        const result = [new UnwrappedTileID(0, tileID)];
        if (this.renderWorldCopies) {
            const utl = this.pointCoordinate(new Point(0, 0));
            const utr = this.pointCoordinate(new Point(this.width, 0));
            const ubl = this.pointCoordinate(new Point(this.width, this.height));
            const ubr = this.pointCoordinate(new Point(0, this.height));
            const w0 = Math.floor(Math.min(utl.x, utr.x, ubl.x, ubr.x));
            const w1 = Math.floor(Math.max(utl.x, utr.x, ubl.x, ubr.x));

            // Add an extra copy of the world on each side to properly render ImageSources and CanvasSources.
            // Both sources draw outside the tile boundaries of the tile that "contains them" so we need
            // to add extra copies on both sides in case offscreen tiles need to draw into on-screen ones.
            const extraWorldCopy = 1;

            for (let w = w0 - extraWorldCopy; w <= w1 + extraWorldCopy; w++) {
                if (w === 0) continue;
                result.push(new UnwrappedTileID(w, tileID));
            }
        }
        return result;
    }

    isLODDisabled(checkPitch: boolean): boolean {
        // No change of LOD behavior for pitch lower than 60 and when there is no top padding: return only tile ids from the requested zoom level
        return (!checkPitch || this.pitch <= MIN_LOD_PITCH) && this._edgeInsets.top <= this._edgeInsets.bottom && !this._elevation && !this.projection.isReprojectedInTileSpace;
    }

    /**
     * Extends tile coverage to include potential neighboring tiles using either a direction vector or quadrant visibility information.
     * @param {Array<OverscaledTileID>} coveringTiles tile cover that is extended
     * @param {number} maxZoom maximum zoom level
     * @param {vec3} direction direction unit vector, if undefined quadrant visibility information is used
     * @returns {Array<OverscaledTileID>} a set of extension tiles
     */
    extendTileCover(coveringTiles: Array<OverscaledTileID>, maxZoom: number, direction?: vec3): Array<OverscaledTileID> {
        let out: OverscaledTileID[] = [];
        const extendDirection = direction != null;
        const extendQuadrants = !extendDirection;
        if (extendQuadrants && this.zoom < maxZoom) return out;
        if (extendDirection && direction[0] === 0.0 && direction[1] === 0.0) return out;

        const addedTiles = new Set<number>();
        const addTileId = (overscaledZ: number, wrap: number, z: number, x: number, y: number) => {
            const key = calculateKey(wrap, overscaledZ, z, x, y);
            if (!addedTiles.has(key)) {
                out.push(new OverscaledTileID(overscaledZ, wrap, z, x, y));
                addedTiles.add(key);
            }
        };

        for (let i = 0; i < coveringTiles.length; i++) {
            const id = coveringTiles[i];

            // Skip if not at the specified zoom level
            if (extendQuadrants && id.canonical.z !== maxZoom) continue;

            const tileId = id.canonical;
            const overscaledZ = id.overscaledZ;
            const tileWrap = id.wrap;
            const tiles = 1 << tileId.z;

            const xMaxInsideRange = tileId.x + 1 < tiles;
            const xMinInsideRange = tileId.x > 0;

            const yMaxInsideRange = tileId.y + 1 < tiles;
            const yMinInsideRange = tileId.y > 0;

            const leftWrap = id.wrap - (xMinInsideRange ? 0 : 1);
            const rightWrap = id.wrap + (xMaxInsideRange ? 0 : 1);

            const leftTileX = xMinInsideRange ? tileId.x - 1 : tiles - 1;
            const rightTileX = xMaxInsideRange ? tileId.x + 1 : 0;

            if (extendDirection) {
                if (direction[0] < 0.0) {
                    addTileId(overscaledZ, rightWrap, tileId.z, rightTileX, tileId.y);
                    if (direction[1] < 0.0 && yMaxInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y + 1);
                        addTileId(overscaledZ, rightWrap, tileId.z, rightTileX, tileId.y + 1);
                    }
                    if (direction[1] > 0.0 && yMinInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y - 1);
                        addTileId(overscaledZ, rightWrap, tileId.z, rightTileX, tileId.y - 1);
                    }
                } else if (direction[0] > 0.0) {
                    addTileId(overscaledZ, leftWrap, tileId.z, leftTileX, tileId.y);
                    if (direction[1] < 0.0 && yMaxInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y + 1);
                        addTileId(overscaledZ, leftWrap, tileId.z, leftTileX, tileId.y + 1);
                    }
                    if (direction[1] > 0.0 && yMinInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y - 1);
                        addTileId(overscaledZ, leftWrap, tileId.z, leftTileX, tileId.y - 1);
                    }
                } else {
                    if (direction[1] < 0.0 && yMaxInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y + 1);
                    } else if (yMinInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y - 1);
                    }
                }
            } else {
                const visibility = id.visibleQuadrants;
                assert(visibility !== undefined);
                // Check each quadrant and add neighboring tiles
                if (visibility & QuadrantVisibility.TopLeft) {
                    addTileId(overscaledZ, leftWrap, tileId.z, leftTileX, tileId.y);
                    if (yMinInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y - 1);
                        addTileId(overscaledZ, leftWrap, tileId.z, leftTileX, tileId.y - 1);
                    }
                }
                if (visibility & QuadrantVisibility.TopRight) {
                    addTileId(overscaledZ, rightWrap, tileId.z, rightTileX, tileId.y);
                    if (yMinInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y - 1);
                        addTileId(overscaledZ, rightWrap, tileId.z, rightTileX, tileId.y - 1);
                    }
                }
                if (visibility & QuadrantVisibility.BottomLeft) {
                    addTileId(overscaledZ, leftWrap, tileId.z, leftTileX, tileId.y);
                    if (yMaxInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y + 1);
                        addTileId(overscaledZ, leftWrap, tileId.z, leftTileX, tileId.y + 1);
                    }
                }
                if (visibility & QuadrantVisibility.BottomRight) {
                    addTileId(overscaledZ, rightWrap, tileId.z, rightTileX, tileId.y);
                    if (yMaxInsideRange) {
                        addTileId(overscaledZ, tileWrap, tileId.z, tileId.x, tileId.y + 1);
                        addTileId(overscaledZ, rightWrap, tileId.z, rightTileX, tileId.y + 1);
                    }
                }
            }
        }

        // Remove higher zoom new IDs that overlap with other new IDs
        const nonOverlappingIds = [];

        for (const id of out) {
            if (!out.some(ancestorCandidate => id.isChildOf(ancestorCandidate))) {
                nonOverlappingIds.push(id);
            }
        }

        // Remove identical IDs
        out = nonOverlappingIds.filter(newId => !coveringTiles.some(oldId => {
            if (newId.overscaledZ < maxZoom && oldId.isChildOf(newId)) {
                return true;
            }
            // Remove identical IDs or children of existing IDs
            return newId.equals(oldId) || newId.isChildOf(oldId);
        }));

        if (extendQuadrants) {
            const numTiles = 1 << maxZoom;
            const isGlobe = this.projection.name === 'globe';
            const cameraCoord = isGlobe ? this._camera.mercatorPosition : this.pointCoordinate(this.getCameraPoint());
            const cameraPoint = [numTiles * cameraCoord.x, numTiles * cameraCoord.y];

            // Keep only closest tiles to the camera position
            // Limit is found experimentally to fix landmark visibility issues in most cases without extending
            // the tile cover too far in high pitch views
            const limit = 4;
            const limitSq = limit * limit;
            out = out.filter(id => {
                const tileCenterX = id.canonical.x + 0.5;
                const tileCenterY = id.canonical.y + 0.5;
                const dx = tileCenterX - cameraPoint[0];
                const dy = tileCenterY - cameraPoint[1];
                const distSq = dx * dx + dy * dy;
                return distSq < limitSq;
            });
        }

        return out;
    }

    /**
     * Extend tile coverage to include tiles that are below the view frustum.
     * @param {Array<OverscaledTileID>} tiles tile cover that is extended
     * @param {Frustum} frustum view frustum
     * @param {number} maxZoom maximum zoom level
     * @returns {Array<OverscaledTileID>} a set of extension tiles
     */
    extendTileCoverToNearPlane(tiles: Array<OverscaledTileID>, frustum: Frustum, maxZoom: number): Array<OverscaledTileID> {
        const out: OverscaledTileID[] = [];

        const addedTiles = new Set<number>();
        // Add existing tile keys to prevent having to remove duplicates later
        for (const tile of tiles) {
            addedTiles.add(tile.key);
        }
        const addTileId = (overscaledZ: number, wrap: number, z: number, x: number, y: number) => {
            const key = calculateKey(wrap, overscaledZ, z, x, y);
            if (!addedTiles.has(key)) {
                out.push(new OverscaledTileID(overscaledZ, wrap, z, x, y));
                addedTiles.add(key);
            }
        };

        const overscaledZ = tiles.reduce((overscaledZ, tile) => {
            return Math.max(overscaledZ, tile.overscaledZ);
        }, maxZoom);

        const numTiles = 1 << maxZoom;

        const tileCorners = [
            new Point(0, 0),
            new Point(EXTENT, 0),
            new Point(EXTENT, EXTENT),
            new Point(0, EXTENT)
        ];

        const p1 = new Point(0, 0);
        const p2 = new Point(0, 0);

        const findTileIntersections = (e1: vec3, e2: vec3) => {
            const e1X = Math.floor(e1[0]);
            const e1Y = Math.floor(e1[1]);
            const e1TileX = (e1[0] - e1X) * EXTENT;
            const e1TileY = (e1[1] - e1Y) * EXTENT;

            const e2X = Math.floor(e2[0]);
            const e2Y = Math.floor(e2[1]);
            const e2TileX = (e2[0] - e2X) * EXTENT;
            const e2TileY = (e2[1] - e2Y) * EXTENT;

            // Find tile intersections from a 3x3 grid around the starting point.
            // This is enough to find the tiles needed for the tile cover extension.
            for (let dx = -1; dx <= 1; dx++) {
                const x = e1X + dx;
                if (x < 0 || x >= numTiles) continue;

                // Convert e1 and e2 (x coord) to the coordinate space of the current tile
                p1.x = e1TileX - dx * EXTENT;
                p2.x = e2TileX - (x - e2X) * EXTENT;

                for (let dy = -1; dy <= 1; dy++) {
                    const y = e1Y + dy;

                    // Convert e1 and e2 (y coord) to the coordinate space of the current tile
                    p1.y = e1TileY - dy * EXTENT;
                    p2.y = e2TileY - (y - e2Y) * EXTENT;

                    if (edgeIntersectsBox(p1, p2, tileCorners)) {
                        addTileId(overscaledZ, 0, maxZoom, x, y);
                    }
                }
            }
        };

        const points = frustum.points;
        const nearBl = points[NEAR_BL];
        const nearBr = points[NEAR_BR];
        const farBl = this._projectToGround(nearBl, points[FAR_BL]);
        const farBr = this._projectToGround(nearBr, points[FAR_BR]);

        findTileIntersections(nearBl, farBl);
        findTileIntersections(nearBr, farBr);

        return out;
    }

    _projectToGround(near: vec3, far: vec3) {
        assert(far[2] < near[2]);
        return vec3.lerp(vec3.create(), near, far, near[2] / (near[2] - far[2]));
    };

    /**
     * Return all coordinates that could cover this transform for a covering
     * zoom level.
     * @param {Object} options
     * @param {number} options.tileSize
     * @param {number} options.minzoom
     * @param {number} options.maxzoom
     * @param {boolean} options.roundZoom
     * @param {boolean} options.reparseOverscaled
     * @returns {Array<OverscaledTileID>} OverscaledTileIDs
     * @private
     */
    coveringTiles(
        options: {
            tileSize: number;
            minzoom?: number;
            maxzoom?: number;
            roundZoom?: boolean;
            reparseOverscaled?: boolean;
            renderWorldCopies?: boolean;
            isTerrainDEM?: boolean;
            calculateQuadrantVisibility?: boolean;
        },
    ): Array<OverscaledTileID> {
        let z = this.coveringZoomLevel(options);
        const actualZ = z;

        const hasExaggeration = this.elevation && this.elevation.exaggeration();
        const useElevationData = hasExaggeration && !options.isTerrainDEM;
        const isMercator = this.projection.name === 'mercator';

        if (options.minzoom !== undefined && z < options.minzoom) return [];
        if (options.maxzoom !== undefined && z > options.maxzoom) z = options.maxzoom;

        const centerCoord = this.locationCoordinate(this.center);
        const centerLatitude = this.center.lat;
        const numTiles = 1 << z;
        const centerPoint = [numTiles * centerCoord.x, numTiles * centerCoord.y, 0];
        const isGlobe = this.projection.name === 'globe';
        const zInMeters = !isGlobe;
        const cameraFrustum = Frustum.fromInvProjectionMatrix(this.invProjMatrix, this.worldSize, z, zInMeters);
        const cameraCoord = isGlobe ? this._camera.mercatorPosition : this.pointCoordinate(this.getCameraPoint());
        const meterToTile = numTiles * mercatorZfromAltitude(1, this.center.lat);
        const cameraAltitude = this._camera.position[2] / mercatorZfromAltitude(1, this.center.lat);
        const cameraPoint = [numTiles * cameraCoord.x, numTiles * cameraCoord.y, cameraAltitude * (zInMeters ? 1 : meterToTile)];
        const verticalFrustumIntersect = isGlobe || hasExaggeration;
        // Let's consider an example for !roundZoom: e.g. tileZoom 16 is used from zoom 16 all the way to zoom 16.99.
        // This would mean that the minimal distance to split would be based on distance from camera to center of 16.99 zoom.
        // The same is already incorporated in logic behind roundZoom for raster (so there is no adjustment needed in following line).
        // 0.02 added to compensate for precision errors, see "coveringTiles for terrain" test in transform.test.js.
        const zoomSplitDistance = this.cameraToCenterDistance / options.tileSize * (options.roundZoom ? 1 : 0.502);

        const minZoom = this.isLODDisabled(true) ? z : 0;

        // When calculating tile cover for terrain, create deep AABB for nodes, to ensure they intersect frustum: for sources,
        // other than DEM, use minimum of visible DEM tiles and center altitude as upper bound (pitch is always less than 90°).
        let maxRange;
        if (this._elevation && options.isTerrainDEM) {
            maxRange = this._elevation.exaggeration() * 10000;
        } else if (this._elevation) {
            const minMaxOpt = this._elevation.getMinMaxForVisibleTiles();
            maxRange = minMaxOpt ? minMaxOpt.max : this._centerAltitude;
        } else {
            maxRange = this._centerAltitude;
        }
        const minRange = options.isTerrainDEM ? -maxRange : this._elevation ? this._elevation.getMinElevationBelowMSL() : 0;

        const scaleAdjustment = this.projection.isReprojectedInTileSpace ? getScaleAdjustment(this) : 1.0;

        const relativeScaleAtMercatorCoord = (mc: MercatorCoordinate) => {
            // Calculate how scale compares between projected coordinates and mercator coordinates.
            // Returns a length. The units don't matter since the result is only
            // used in a ratio with other values returned by this function.

            // Construct a small square in Mercator coordinates.
            const offset = 1 / 40000;
            const mcEast = new MercatorCoordinate(mc.x + offset, mc.y, mc.z);
            const mcSouth = new MercatorCoordinate(mc.x, mc.y + offset, mc.z);

            // Convert the square to projected coordinates.
            const ll = mc.toLngLat();
            const llEast = mcEast.toLngLat();
            const llSouth = mcSouth.toLngLat();
            const p = this.locationCoordinate(ll);
            const pEast = this.locationCoordinate(llEast);
            const pSouth = this.locationCoordinate(llSouth);

            // Calculate the size of each edge of the reprojected square
            const dx = Math.hypot(pEast.x - p.x, pEast.y - p.y);
            const dy = Math.hypot(pSouth.x - p.x, pSouth.y - p.y);

            // Calculate the size of a projected square that would have the
            // same area as the reprojected square.
            return Math.sqrt(dx * dy) * scaleAdjustment / offset;
        };

        const newRootTile = (wrap: number): RootTile => {
            const max = maxRange;
            const min = minRange;
            return {
                // With elevation, this._elevation provides z coordinate values. For 2D:
                // All tiles are on zero elevation plane => z difference is zero
                aabb: tileAABB(this, numTiles, 0, 0, 0, wrap, min, max, this.projection),
                zoom: 0,
                x: 0,
                y: 0,
                minZ: min,
                maxZ: max,
                wrap,
                fullyVisible: false
            };
        };

        // Do a depth-first traversal to find visible tiles and proper levels of detail
        const stack: RootTile[] = [];
        let result: Array<{tileID: OverscaledTileID, distanceSq: number}> = [];
        const maxZoom = z;
        const overscaledZ = options.reparseOverscaled ? actualZ : z;
        const cameraHeight = (cameraAltitude - this._centerAltitude) * meterToTile; // in tile coordinates.

        const getAABBFromElevation = (it: RootTile) => {
            assert(this._elevation);
            if (!this._elevation || !it.tileID || !isMercator) return; // To silence flow.
            const minmax = this._elevation.getMinMaxForTile(it.tileID);
            const aabb = it.aabb;
            if (minmax) {
                aabb.min[2] = minmax.min;
                aabb.max[2] = minmax.max;
                aabb.center[2] = (aabb.min[2] + aabb.max[2]) / 2;
            } else {
                it.shouldSplit = shouldSplit(it);
                if (!it.shouldSplit) {
                    // At final zoom level, while corresponding DEM tile is not loaded yet,
                    // assume center elevation. This covers ground to horizon and prevents
                    // loading unnecessary tiles until DEM cover is fully loaded.
                    aabb.min[2] = aabb.max[2] = aabb.center[2] = this._centerAltitude;
                }
            }
        };

        // Scale distance to split for acute angles.
        // dzSqr: z component of camera to tile distance, square.
        // dSqr: 3D distance of camera to tile, square.
        const distToSplitScale = (dz: number, d: number) => {
            // When the angle between camera to tile ray and tile plane is smaller
            // than acuteAngleThreshold, scale the distance to split. Scaling is adaptive: smaller
            // the angle, the scale gets lower value. Although it seems early to start at 45,
            // it is not: scaling kicks in around 60 degrees pitch.
            const acuteAngleThresholdSin = 0.707; // Math.sin(45)
            const stretchTile = 1.1;
            // Distances longer than 'dz / acuteAngleThresholdSin' gets scaled
            // following geometric series sum: every next dz length in distance can be
            // 'stretchTile times' longer. It is further, the angle is sharper. Total,
            // adjusted, distance would then be:
            // = dz / acuteAngleThresholdSin + (dz * stretchTile + dz * stretchTile ^ 2 + ... + dz * stretchTile ^ k),
            // where k = (d - dz / acuteAngleThresholdSin) / dz = d / dz - 1 / acuteAngleThresholdSin;
            // = dz / acuteAngleThresholdSin + dz * ((stretchTile ^ (k + 1) - 1) / (stretchTile - 1) - 1)
            // or put differently, given that k is based on d and dz, tile on distance d could be used on distance scaled by:
            // 1 / acuteAngleThresholdSin + (stretchTile ^ (k + 1) - 1) / (stretchTile - 1) - 1
            if (d * acuteAngleThresholdSin < dz) return 1.0; // Early return, no scale.
            const r = d / dz;
            const k =  r - 1 / acuteAngleThresholdSin;
            return r / (1 / acuteAngleThresholdSin + (Math.pow(stretchTile, k + 1) - 1) / (stretchTile - 1) - 1);
        };

        const shouldSplit = (it: RootTile) => {
            if (it.zoom < minZoom) {
                return true;
            } else if (it.zoom === maxZoom) {
                return false;
            }
            if (it.shouldSplit != null) {
                return it.shouldSplit;
            }
            const dx = it.aabb.distanceX(cameraPoint);
            const dy = it.aabb.distanceY(cameraPoint);
            let dz = cameraHeight;

            let tileScaleAdjustment = 1;
            if (isGlobe) {
                dz = it.aabb.distanceZ(cameraPoint);
                // Compensate physical sizes of the tiles when determining which zoom level to use.
                // In practice tiles closer to poles should use more aggressive LOD as their
                // physical size is already smaller than size of tiles near the equator.
                const tilesAtZoom = Math.pow(2, it.zoom);
                const minLat = latFromMercatorY((it.y + 1) / tilesAtZoom);
                const maxLat = latFromMercatorY((it.y) / tilesAtZoom);
                const closestLat = Math.min(Math.max(centerLatitude, minLat), maxLat);

                const relativeTileScale = circumferenceAtLatitude(closestLat) / circumferenceAtLatitude(centerLatitude);

                // With globe, the rendered scale does not exactly match the mercator scale at low zoom levels.
                // Account for this difference during LOD of loading so that you load the correct size tiles.
                // We try to compromise between two conflicting requirements:
                // - loading tiles at the camera's zoom level (for visual and styling consistency)
                // - loading correct size tiles (to reduce the number of tiles loaded)
                // These are arbitrarily balanced:
                if (closestLat === centerLatitude) {
                    // For tiles that are in the middle of the viewport, prioritize matching the camera
                    // zoom and allow divergence from the true scale.
                    const maxDivergence = 0.3;
                    tileScaleAdjustment = 1 / Math.max(1, this._mercatorScaleRatio - maxDivergence);
                } else {
                    // For other tiles, use the real scale to reduce tile counts near poles.
                    tileScaleAdjustment = Math.min(1, relativeTileScale / this._mercatorScaleRatio);
                }

                // Ensure that all tiles near the center have the same zoom level.
                // With LOD tile loading, tile zoom levels can change when scale slightly changes.
                // These differences can be pretty different in globe view. Work around this by
                // making more tiles match the center tile's zoom level. If the tiles are nearly big enough,
                // round up. Only apply this adjustment before the transition to mercator rendering has started.
                if (this.zoom <= GLOBE_ZOOM_THRESHOLD_MIN && it.zoom === maxZoom - 1 && relativeTileScale >= 0.9) {
                    return true;
                }
            } else {
                assert(zInMeters);
                if (useElevationData) {
                    dz = it.aabb.distanceZ(cameraPoint) * meterToTile;
                }
                if (this.projection.isReprojectedInTileSpace && actualZ <= 5) {
                    // In other projections, not all tiles are the same size.
                    // Account for the tile size difference by adjusting the distToSplit.
                    // Adjust by the ratio of the area at the tile center to the area at the map center.
                    // Adjustments are only needed at lower zooms where tiles are not similarly sized.
                    const numTiles = Math.pow(2, it.zoom);
                    const relativeScale = relativeScaleAtMercatorCoord(new MercatorCoordinate((it.x + 0.5) / numTiles, (it.y + 0.5) / numTiles));
                    // Fudge the ratio slightly so that all tiles near the center have the same zoom level.
                    tileScaleAdjustment = relativeScale > 0.85 ? 1 : relativeScale;
                }
            }

            if (!isMercator) {
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                let distToSplit = (1 << maxZoom - it.zoom) * zoomSplitDistance * tileScaleAdjustment;
                distToSplit = distToSplit * distToSplitScale(Math.max(dz, cameraHeight), distance);
                return distance < distToSplit;
            }

            let closestDistance = Number.MAX_VALUE;
            let closestElevation = 0.0;
            const corners = it.aabb.getCorners();
            const distanceXyz = [];
            for (const corner of corners) {
                vec3.sub(distanceXyz as unknown as vec3, corner, cameraPoint as unknown as vec3);
                if (!isGlobe) {
                    if (useElevationData) {
                        distanceXyz[2] *= meterToTile;
                    } else {
                        distanceXyz[2] = cameraHeight;
                    }
                }
                const dist = vec3.dot(distanceXyz as unknown as vec3, this._camera.forward());
                if (dist < closestDistance) {
                    closestDistance = dist;
                    closestElevation = Math.abs(distanceXyz[2]);
                }
            }

            let distToSplit = (1 << (maxZoom - it.zoom)) * zoomSplitDistance * tileScaleAdjustment;
            distToSplit *= distToSplitScale(Math.max(closestElevation, cameraHeight), closestDistance);

            if (closestDistance < distToSplit) {
                return true;
            }
            // Border case: with tilt of 85 degrees, center could be outside max zoom distance, due to scale.
            // Ensure max zoom tiles over center.
            const closestPointToCenter = it.aabb.closestPoint(centerPoint as unknown as vec3);
            return (closestPointToCenter[0] === centerPoint[0] && closestPointToCenter[1] === centerPoint[1]);
        };

        if (this.renderWorldCopies) {
            // Render copy of the globe thrice on both sides
            for (let i = 1; i <= NUM_WORLD_COPIES; i++) {
                stack.push(newRootTile(-i));
                stack.push(newRootTile(i));
            }
        }

        stack.push(newRootTile(0));

        while (stack.length > 0) {
            const it = stack.pop();
            const x = it.x;
            const y = it.y;
            let fullyVisible = it.fullyVisible;

            const isPoleNeighbourAndGlobeProjection = () => {
                return this.projection.name === 'globe' && (it.y === 0 || it.y === (1 << it.zoom) - 1);
            };

            // Visibility of a tile is not required if any of its ancestor is fully inside the frustum
            if (!fullyVisible) {
                let intersectResult = verticalFrustumIntersect ? it.aabb.intersects(cameraFrustum) : it.aabb.intersectsFlat(cameraFrustum);

                // For globe projection and pole neighboouring tiles - clip against pole segments as well
                if (intersectResult === 0 && isPoleNeighbourAndGlobeProjection()) {
                    const tileId = new CanonicalTileID(it.zoom, x, y);
                    const poleAABB = aabbForTileOnGlobe(this, numTiles, tileId, true);
                    intersectResult = poleAABB.intersects(cameraFrustum);
                }

                if (intersectResult === 0) {
                    continue;
                }
                fullyVisible = intersectResult === 2;
            }

            // Have we reached the target depth or is the tile too far away to be any split further?
            if (it.zoom === maxZoom || !shouldSplit(it)) {
                const tileZoom = it.zoom === maxZoom ? overscaledZ : it.zoom;
                if (!!options.minzoom && options.minzoom > tileZoom) {
                    // Not within source tile range.
                    continue;
                }

                let visibility: QuadrantMask = QuadrantVisibility.None;
                if (!fullyVisible) {
                    let intersectResult = verticalFrustumIntersect ? it.aabb.intersectsPrecise(cameraFrustum) : it.aabb.intersectsPreciseFlat(cameraFrustum);

                    // For globe projection and pole neighboouring tiles - clip against pole segments as well
                    if (intersectResult === 0 && isPoleNeighbourAndGlobeProjection()) {
                        const tileId = new CanonicalTileID(it.zoom, x, y);
                        const poleAABB = aabbForTileOnGlobe(this, numTiles, tileId, true);
                        intersectResult = poleAABB.intersectsPrecise(cameraFrustum);
                    }

                    if (intersectResult === 0) {
                        continue;
                    }

                    // Calculate quadrant visibility for tiles that are not fully visible
                    if (options.calculateQuadrantVisibility) {
                        // If the center point is visible, then all quadrants are as well
                        if (cameraFrustum.containsPoint(it.aabb.center)) {
                            visibility = QuadrantVisibility.All;
                        } else {
                            for (let i = 0; i < 4; i++) {
                                const quadrantAabb = it.aabb.quadrant(i);
                                if (quadrantAabb.intersects(cameraFrustum) !== 0) {
                                    visibility |= 1 << i;
                                }
                            }
                        }
                    }
                }

                const dx = centerPoint[0] - ((0.5 + x + (it.wrap << it.zoom)) * (1 << (z - it.zoom)));
                const dy = centerPoint[1] - 0.5 - y;
                const id = it.tileID ? it.tileID : new OverscaledTileID(tileZoom, it.wrap, it.zoom, x, y);
                if (options.calculateQuadrantVisibility) {
                    id.visibleQuadrants = visibility;
                }
                result.push({tileID: id, distanceSq: dx * dx + dy * dy});

                continue;
            }

            for (let i = 0; i < 4; i++) {
                const childX = (x << 1) + (i % 2);
                const childY = (y << 1) + (i >> 1);

                const aabb = isMercator ? it.aabb.quadrant(i) : tileAABB(this, numTiles, it.zoom + 1, childX, childY, it.wrap, it.minZ, it.maxZ, this.projection);
                const child: RootTile = {aabb, zoom: it.zoom + 1, x: childX, y: childY, wrap: it.wrap, fullyVisible, tileID: undefined, shouldSplit: undefined, minZ: it.minZ, maxZ: it.maxZ};
                if (useElevationData && !isGlobe) {
                    child.tileID = new OverscaledTileID(it.zoom + 1 === maxZoom ? overscaledZ : it.zoom + 1, it.wrap, it.zoom + 1, childX, childY);
                    getAABBFromElevation(child);
                }
                stack.push(child);
            }
        }

        if (this.fogCullDistSq) {
            const fogCullDistSq = this.fogCullDistSq;
            const horizonLineFromTop = this.horizonLineFromTop();
            result = result.filter(entry => {
                const tl: [number, number, number, number] = [0, 0, 0, 1];
                const br: [number, number, number, number] = [EXTENT, EXTENT, 0, 1];

                const fogTileMatrix = this.calculateFogTileMatrix(entry.tileID.toUnwrapped());

                vec4.transformMat4(tl, tl, fogTileMatrix);
                vec4.transformMat4(br, br, fogTileMatrix);

                // the fog matrix can flip the min/max values, so we calculate them explicitly
                const min = vec4.min([] as unknown as vec4, tl, br) as number[];
                const max = vec4.max([] as unknown as vec4, tl, br) as number[];

                const sqDist = getAABBPointSquareDist(min, max);

                if (sqDist === 0) { return true; }

                let overHorizonLine = false;

                // Terrain loads at one zoom level lower than the raster data,
                // so the following checks whether the terrain sits above the horizon and ensures that
                // when mountains stick out above the fog (due to horizon-blend),
                // we haven’t accidentally culled some of the raster tiles we need to draw on them.
                // If we don’t do this, the terrain is default black color and may flash in and out as we move toward it.

                const elevation = this._elevation;

                if (elevation && sqDist > fogCullDistSq && horizonLineFromTop !== 0) {
                    const projMatrix = this.calculateProjMatrix(entry.tileID.toUnwrapped());

                    let minmax;
                    if (!options.isTerrainDEM) {
                        minmax = elevation.getMinMaxForTile(entry.tileID);
                    }

                    if (!minmax) { minmax = {min: minRange, max: maxRange}; }

                    // ensure that we want `this.rotation` instead of `this.bearing` here
                    const cornerFar = furthestTileCorner(this.rotation);

                    const farX = cornerFar[0] * EXTENT;
                    const farY = cornerFar[1] * EXTENT;

                    const worldFar = [farX, farY, minmax.max];

                    // World to NDC
                    vec3.transformMat4(worldFar as [number, number, number], worldFar as [number, number, number], projMatrix);

                    // NDC to Screen
                    const screenCoordY = (1 - worldFar[1]) * this.height * 0.5;

                    // Prevent cutting tiles crossing over the horizon line to
                    // prevent pop-in and out within the fog culling range
                    overHorizonLine = screenCoordY < horizonLineFromTop;
                }

                return sqDist < fogCullDistSq || overHorizonLine;
            });
        }

        const cover = result.sort((a, b) => a.distanceSq - b.distanceSq).map(a => a.tileID);

        // Relax the assertion on terrain, on high zoom we use distance to center of tile
        // while camera might be closer to selected center of map.
        assert(!cover.length || this.elevation || cover[0].overscaledZ === overscaledZ || !isMercator);
        return cover;
    }

    resize(width: number, height: number) {
        this.width = width;
        this.height = height;

        this.pixelsToGLUnits = [2 / width, -2 / height];
        this._constrain();
        this._calcMatrices();
    }

    get unmodified(): boolean { return this._unmodified; }

    zoomScale(zoom: number): number { return Math.pow(2, zoom); }
    scaleZoom(scale: number): number { return Math.log(scale) / Math.LN2; }

    // Transform from LngLat to Point in world coordinates [-180, 180] x [90, -90] --> [0, this.worldSize] x [0, this.worldSize]
    project(lnglat: LngLat): Point {
        const lat = clamp(lnglat.lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
        const projectedLngLat = this.projection.project(lnglat.lng, lat);
        return new Point(
                projectedLngLat.x * this.worldSize,
                projectedLngLat.y * this.worldSize);
    }

    // Transform from Point in world coordinates to LngLat [0, this.worldSize] x [0, this.worldSize] --> [-180, 180] x [90, -90]
    unproject(point: Point): LngLat {
        return this.projection.unproject(point.x / this.worldSize, point.y / this.worldSize);
    }

    // Point at center in world coordinates.
    get point(): Point { return this.project(this.center); }

    // Point at center in Mercator coordinates.
    get pointMerc(): Point { return this.point._div(this.worldSize); }

    // Ratio of pixelsPerMeter in the current projection to Mercator's.
    get pixelsPerMeterRatio(): number { return this.pixelsPerMeter / mercatorZfromAltitude(1, this.center.lat) / this.worldSize; }

    setLocationAtPoint(lnglat: LngLat, point: Point) {
        let x, y;
        const centerPoint = this.centerPoint;

        if (this.projection.name === 'globe') {
            // Pixel coordinates are applied directly to the globe
            const worldSize = this.worldSize;
            x = (point.x - centerPoint.x) / worldSize;
            y = (point.y - centerPoint.y) / worldSize;
        } else {
            const a = this.pointCoordinate(point);
            const b = this.pointCoordinate(centerPoint);
            x = a.x - b.x;
            y = a.y - b.y;
        }

        const loc = this.locationCoordinate(lnglat);
        this.setLocation(new MercatorCoordinate(loc.x - x, loc.y - y));
    }

    setLocation(location: MercatorCoordinate) {
        this.center = this.coordinateLocation(location);
        if (this.projection.wrap) {
            this.center = this.center.wrap();
        }
    }

    /**
     * Given a location, return the screen point that corresponds to it. In 3D mode
     * (with terrain) this behaves the same as in 2D mode.
     * This method is coupled with {@see pointLocation} in 3D mode to model map manipulation
     * using flat plane approach to keep constant elevation above ground.
     * @param {LngLat} lnglat location
     * @param {number} altitude (optional) altitude above the map plane in meters.
     * @returns {Point} screen point
     * @private
     */
    locationPoint(lnglat: LngLat, altitude?: number): Point {
        return this.projection.locationPoint(this, lnglat, altitude);
    }

    /**
     * Given a location, return the screen point that corresponds to it
     * In 3D mode (when terrain is enabled) elevation is sampled for the point before
     * projecting it. In 2D mode, behaves the same locationPoint.
     * @param {LngLat} lnglat location
     * @param {number} altitude (optional) altitude above the map plane in meters.
     * @returns {Point} screen point
     * @private
     */
    locationPoint3D(lnglat: LngLat, altitude?: number): Point {
        return this.projection.locationPoint(this, lnglat, altitude, true);
    }

    /**
     * Given a point on screen, return its lnglat
     * @param {Point} p screen point
     * @returns {LngLat} lnglat location
     * @private
     */
    pointLocation(p: Point): LngLat {
        return this.coordinateLocation(this.pointCoordinate(p));
    }

    /**
     * Given a point on screen, return its lnglat
     * In 3D mode (map with terrain) returns location of terrain raycast point.
     * In 2D mode, behaves the same as {@see pointLocation}.
     * @param {Point} p screen point
     * @param {number} altitude (optional) altitude above the map plane in meters.
     * @returns {LngLat} lnglat location
     * @private
     */
    pointLocation3D(p: Point, altitude?: number): LngLat {
        return this.coordinateLocation(this.pointCoordinate3D(p, altitude));
    }

    /**
     * Given a geographical lngLat, return an unrounded
     * coordinate that represents it at this transform's zoom level.
     * @param {LngLat} lngLat
     * @param {number} altitude (optional) altitude above the map plane in meters.
     * @returns {Coordinate}
     * @private
     */
    locationCoordinate(lngLat: LngLat, altitude?: number): MercatorCoordinate {
        const z = altitude ?
            mercatorZfromAltitude(altitude, lngLat.lat) :
            undefined;
        const projectedLngLat = this.projection.project(lngLat.lng, lngLat.lat);
        return new MercatorCoordinate(
            projectedLngLat.x,
            projectedLngLat.y,
            z);
    }

    /**
     * Given a Coordinate, return its geographical position.
     * @param {Coordinate} coord
     * @returns {LngLat} lngLat
     * @private
     */
    coordinateLocation(coord: MercatorCoordinate): LngLat {
        return this.projection.unproject(coord.x, coord.y);
    }

    /**
     * Casts a ray from a point on screen and returns the Ray,
     * and the extent along it, at which it intersects the map plane.
     *
     * @param {Point} p Viewport pixel co-ordinates.
     * @param {number} z Optional altitude of the map plane, defaulting to elevation at center.
     * @returns {{ p0: Vec4, p1: Vec4, t: number }} p0,p1 are two points on the ray.
     * t is the fractional extent along the ray at which the ray intersects the map plane.
     * @private
     */
    pointRayIntersection(p: Point, z?: number | null): RayIntersectionResult {
        const targetZ = (z !== undefined && z !== null) ? z : this._centerAltitude;
        // Since we don't know the correct projected z value for the point,
        // unproject two points to get a line and then find the point on that
        // line with z=0.

        const p0: [number, number, number, number] = [p.x, p.y, 0, 1];
        const p1: [number, number, number, number] = [p.x, p.y, 1, 1];

        vec4.transformMat4(p0, p0, this.pixelMatrixInverse);
        vec4.transformMat4(p1, p1, this.pixelMatrixInverse);

        const w0 = p0[3];
        const w1 = p1[3];
        vec4.scale(p0, p0, 1 / w0);
        vec4.scale(p1, p1, 1 / w1);

        const z0 = p0[2];
        const z1 = p1[2];

        const t = z0 === z1 ? 0 : (targetZ - z0) / (z1 - z0);

        return {p0, p1, t};
    }

    screenPointToMercatorRay(p: Point): Ray {
        const p0: [number, number, number, number] = [p.x, p.y, 0, 1];
        const p1: [number, number, number, number] = [p.x, p.y, 1, 1];

        vec4.transformMat4(p0, p0, this.pixelMatrixInverse);
        vec4.transformMat4(p1, p1, this.pixelMatrixInverse);

        vec4.scale(p0, p0, 1 / p0[3]);
        vec4.scale(p1, p1, 1 / p1[3]);

        // Convert altitude from meters to pixels.
        p0[2] = mercatorZfromAltitude(p0[2], this._center.lat) * this.worldSize;
        p1[2] = mercatorZfromAltitude(p1[2], this._center.lat) * this.worldSize;

        vec4.scale(p0, p0, 1 / this.worldSize);
        vec4.scale(p1, p1, 1 / this.worldSize);

        return new Ray([p0[0], p0[1], p0[2]], vec3.normalize([] as unknown as vec3, vec3.sub([] as unknown as vec3, p1 as unknown as vec3, p0 as unknown as vec3)));
    }

    /**
     *  Helper method to convert the ray intersection with the map plane to MercatorCoordinate.
     *
     * @param {RayIntersectionResult} rayIntersection
     * @returns {MercatorCoordinate}
     * @private
     */
    rayIntersectionCoordinate(rayIntersection: RayIntersectionResult): MercatorCoordinate {
        const {p0, p1, t} = rayIntersection;

        const z0 = mercatorZfromAltitude(p0[2], this._center.lat);
        const z1 = mercatorZfromAltitude(p1[2], this._center.lat);

        return new MercatorCoordinate(
            interpolate(p0[0], p1[0], t) / this.worldSize,
            interpolate(p0[1], p1[1], t) / this.worldSize,
            interpolate(z0, z1, t));
    }

    /**
     * Given a point on screen, returns MercatorCoordinate.
     * @param {Point} p Top left origin screen point, in pixels.
     * @param {number} z Optional altitude of the map plane, defaulting to elevation at center.
     * @private
     */
    pointCoordinate(p: Point, z: number = this._centerAltitude): MercatorCoordinate {
        return this.projection.pointCoordinate(this, p.x, p.y, z);
    }

    /**
     * Given a point on screen, returns MercatorCoordinate.
     * In 3D mode, raycast to terrain. In 2D mode, behaves the same as {@see pointCoordinate}.
     * For p above terrain, don't return point behind camera but clamp p.y at the top of terrain.
     * @param {Point} p top left origin screen point, in pixels.
     * @param {number} altitude (optional) altitude above the map plane in meters.
     * @private
     */
    pointCoordinate3D(p: Point, altitude?: number): MercatorCoordinate {
        if (!this.elevation) return this.pointCoordinate(p, altitude);
        let raycast: vec3 | null | undefined = this.projection.pointCoordinate3D(this, p.x, p.y);
        if (raycast) return new MercatorCoordinate(raycast[0], raycast[1], raycast[2]);
        let start = 0, end = this.horizonLineFromTop();
        if (p.y > end) return this.pointCoordinate(p, altitude); // holes between tiles below horizon line or below bottom.
        const samples = 10;
        const threshold = 0.02 * end;
        const r = p.clone();

        for (let i = 0; i < samples && end - start > threshold; i++) {
            r.y = interpolate(start, end, 0.66); // non uniform binary search favoring points closer to horizon.
            const rCast = this.projection.pointCoordinate3D(this, r.x, r.y);
            if (rCast) {
                end = r.y;
                raycast = rCast;
            } else {
                start = r.y;
            }
        }
        return raycast ? new MercatorCoordinate(raycast[0], raycast[1], raycast[2]) : this.pointCoordinate(p);
    }

    /**
     * Returns true if a screenspace Point p, is above the horizon.
     * In non-globe projections, this approximates the map as an infinite plane and does not account for z0-z3
     * wherein the map is small quad with whitespace above the north pole and below the south pole.
     *
     * @param {Point} p
     * @returns {boolean}
     * @private
     */
    isPointAboveHorizon(p: Point): boolean {
        return this.projection.isPointAboveHorizon(this, p);
    }

    /**
     * Determines if the given point is located on a visible map surface.
     *
     * @param {Point} p
     * @returns {boolean}
     * @private
     */
    isPointOnSurface(p: Point): boolean {
        if (p.y < 0 || p.y > this.height || p.x < 0 || p.x > this.width) return false;
        if (this.elevation || this.zoom >= GLOBE_ZOOM_THRESHOLD_MAX) return !this.isPointAboveHorizon(p);
        const coord = this.pointCoordinate(p);
        return coord.y >= 0 && coord.y <= 1;
    }

    /**
     * Given a coordinate, return the screen point that corresponds to it
     * @param {Coordinate} coord
     * @param {boolean} sampleTerrainIn3D in 3D mode (terrain enabled), sample elevation for the point.
     * If false, do the same as in 2D mode, assume flat camera elevation plane for all points.
     * @returns {Point} screen point
     * @private
     */
    _coordinatePoint(coord: MercatorCoordinate, sampleTerrainIn3D: boolean): Point {
        const elevation = sampleTerrainIn3D && this.elevation ? this.elevation.getAtPointOrZero(coord, this._centerAltitude) : this._centerAltitude;
        const p = [coord.x * this.worldSize, coord.y * this.worldSize, elevation + coord.toAltitude(), 1];
        vec4.transformMat4(p as [number, number, number, number], p as [number, number, number, number], this.pixelMatrix);
        return p[3] > 0 ?
            new Point(p[0] / p[3], p[1] / p[3]) :
            new Point(Number.MAX_VALUE, Number.MAX_VALUE);
    }

    // In Globe, conic and thematic projections, Lng/Lat extremes are not always at corners.
    // This function additionally checks each screen edge midpoint.
    // While midpoints continue to be extremes, it recursively checks midpoints of smaller segments.
    _getBoundsNonRectangular(): LngLatBounds {
        assert(!this.projection.supportsWorldCopies, "Rectangular projections should use the simpler _getBoundsRectangular");
        const {top, left} = this._edgeInsets;
        const bottom = this.height - this._edgeInsets.bottom;
        const right = this.width - this._edgeInsets.right;

        const tl = this.pointLocation3D(new Point(left, top));
        const tr = this.pointLocation3D(new Point(right, top));
        const br = this.pointLocation3D(new Point(right, bottom));
        const bl = this.pointLocation3D(new Point(left, bottom));

        let west = Math.min(tl.lng, tr.lng, br.lng, bl.lng);
        let east = Math.max(tl.lng, tr.lng, br.lng, bl.lng);
        let south = Math.min(tl.lat, tr.lat, br.lat, bl.lat);
        let north = Math.max(tl.lat, tr.lat, br.lat, bl.lat);

        // we pick an error threshold for calculating the bbox that balances between performance and precision
        // Roughly emulating behavior of maxErr in tile_transform.js
        const s = Math.pow(2, -this.zoom);
        const maxErr = s / 16 * 270; // 270 = avg(180, 360) i.e. rough conversion between Mercator coords and Lat/Lng

        // We check a minimum of 15 points on each side for Albers, etc.
        // We check a minmum of one midpoint on each side per globe.
        // Globe checks require raytracing and are slower
        // and mising area near the horizon is highly compressed so not noticeable
        const minRecursions = this.projection.name === "globe" ? 1 : 4;

        const processSegment = (ax: number, ay: number, bx: number, by: number, depth: number) => {
            const mx = (ax + bx) / 2;
            const my = (ay + by) / 2;

            const p = new Point(mx, my);
            const {lng, lat} = this.pointLocation3D(p);

            // The error metric is the maximum change to bounds from a given point
            const err = Math.max(0, west - lng, south - lat, lng - east, lat - north);

            west = Math.min(west, lng);
            east = Math.max(east, lng);
            south = Math.min(south, lat);
            north = Math.max(north, lat);

            if (depth < minRecursions || err > maxErr) {
                processSegment(ax, ay, mx, my, depth + 1);
                processSegment(mx, my, bx, by, depth + 1);
            }
        };

        processSegment(left, top, right, top, 1);
        processSegment(right, top, right, bottom, 1);
        processSegment(right, bottom, left, bottom, 1);
        processSegment(left, bottom, left, top, 1);

        if (this.projection.name === "globe") {
            const [northPoleIsVisible, southPoleIsVisible] = polesInViewport(this);
            if (northPoleIsVisible) {
                north = 90;
                east = 180;
                west = -180;
            } else if (southPoleIsVisible) {
                south = -90;
                east = 180;
                west = -180;
            }
        }

        return new LngLatBounds(new LngLat(west, south), new LngLat(east, north));
    }

    _getBoundsRectangular(min: number, max: number): LngLatBounds {
        assert(this.projection.supportsWorldCopies, "_getBoundsRectangular only checks corners and works only on rectangular projections. Other projections should use _getBoundsNonRectangular");

        const {top, left} = this._edgeInsets;
        const bottom = this.height - this._edgeInsets.bottom;
        const right = this.width - this._edgeInsets.right;

        const topLeft = new Point(left, top);
        const topRight = new Point(right, top);
        const bottomRight = new Point(right, bottom);
        const bottomLeft = new Point(left, bottom);

        // Consider far points at the maximum possible elevation
        // and near points at the minimum to ensure full coverage.
        let tl = this.pointCoordinate(topLeft, min);
        let tr = this.pointCoordinate(topRight, min);
        const br = this.pointCoordinate(bottomRight, max);
        const bl = this.pointCoordinate(bottomLeft, max);

        // If map pitch places top corners off map edge (latitude > 90 or < -90),
        // place them at the intersection between the left/right screen edge and map edge.
        const slope = (p1: MercatorCoordinate, p2: MercatorCoordinate) => (p2.y - p1.y) / (p2.x - p1.x);

        if (tl.y > 1 && tr.y >= 0) tl = new MercatorCoordinate((1 - bl.y) / slope(bl, tl) + bl.x, 1);
        else if (tl.y < 0 && tr.y <= 1) tl = new MercatorCoordinate(-bl.y / slope(bl, tl) + bl.x, 0);

        if (tr.y > 1 && tl.y >= 0) tr = new MercatorCoordinate((1 - br.y) / slope(br, tr) + br.x, 1);
        else if (tr.y < 0 && tl.y <= 1) tr = new MercatorCoordinate(-br.y / slope(br, tr) + br.x, 0);

        return new LngLatBounds()
            .extend(this.coordinateLocation(tl))
            .extend(this.coordinateLocation(tr))
            .extend(this.coordinateLocation(bl))
            .extend(this.coordinateLocation(br));
    }

    _getBoundsRectangularTerrain(): LngLatBounds {
        assert(this.elevation);
        const elevation = (this.elevation);
        if (!elevation.visibleDemTiles.length || elevation.isUsingMockSource()) { return this._getBoundsRectangular(0, 0); }
        const minmax = elevation.visibleDemTiles.reduce((acc, t) => {
            if (t.dem) {
                const tree = t.dem.tree;
                acc.min = Math.min(acc.min, tree.minimums[0]);
                acc.max = Math.max(acc.max, tree.maximums[0]);
            }
            return acc;
        }, {min: Number.MAX_VALUE, max: 0});
        assert(minmax.min !== Number.MAX_VALUE);
        return this._getBoundsRectangular(minmax.min * elevation.exaggeration(), minmax.max * elevation.exaggeration());
    }

    /**
     * Returns the map's geographical bounds. When the bearing or pitch is non-zero, the visible region is not
     * an axis-aligned rectangle, and the result is the smallest bounds that encompasses the visible region.
     *
     * @returns {LngLatBounds} Returns a {@link LngLatBounds} object describing the map's geographical bounds.
     */
    getBounds(): LngLatBounds {
        if (this.projection.name === 'mercator' || this.projection.name === 'equirectangular') {
            if (this._terrainEnabled()) return this._getBoundsRectangularTerrain();
            return this._getBoundsRectangular(0, 0);
        }
        return this._getBoundsNonRectangular();
    }

    /**
     * Returns position of horizon line from the top of the map in pixels.
     * If horizon is not visible, returns 0 by default or a negative value if called with clampToTop = false.
     * @private
     */
    horizonLineFromTop(clampToTop: boolean = true): number {
        // h is height of space above map center to horizon.
        const h = this.height / 2 / Math.tan(this._fov / 2) / Math.tan(Math.max(this._pitch, 0.1)) - this.centerOffset.y;
        const offset = this.height / 2 - h * (1 - this._horizonShift);
        return clampToTop ? Math.max(0, offset) : offset;
    }

    /**
     * Returns the maximum geographical bounds the map is constrained to, or `null` if none set.
     * @returns {LngLatBounds} {@link LngLatBounds}.
     */
    getMaxBounds(): LngLatBounds | null | undefined {
        return this.maxBounds;
    }

    /**
     * Sets or clears the map's geographical constraints.
     *
     * @param {LngLatBounds} bounds A {@link LngLatBounds} object describing the new geographic boundaries of the map.
     */
    setMaxBounds(bounds?: LngLatBounds | null) {
        this.maxBounds = bounds;

        this.minLat = -MAX_MERCATOR_LATITUDE;
        this.maxLat = MAX_MERCATOR_LATITUDE;
        this.minLng = -180;
        this.maxLng = 180;

        if (bounds) {
            this.minLat = bounds.getSouth();
            this.maxLat = bounds.getNorth();
            this.minLng = bounds.getWest();
            this.maxLng = bounds.getEast();
            if (this.maxLng < this.minLng) this.maxLng += 360;
        }

        this.worldMinX = mercatorXfromLng(this.minLng) * this.tileSize;
        this.worldMaxX = mercatorXfromLng(this.maxLng) * this.tileSize;
        this.worldMinY = mercatorYfromLat(this.maxLat) * this.tileSize;
        this.worldMaxY = mercatorYfromLat(this.minLat) * this.tileSize;

        this._constrain();
    }

    calculatePosMatrix(unwrappedTileID: UnwrappedTileID, worldSize: number): mat4 {
        return this.projection.createTileMatrix(this, worldSize, unwrappedTileID);
    }

    calculateDistanceTileData(unwrappedTileID: UnwrappedTileID): FeatureDistanceData {
        const distanceDataKey = unwrappedTileID.key;
        const cache = this._distanceTileDataCache;
        if (cache[distanceDataKey]) {
            return cache[distanceDataKey];
        }

        //Calculate the offset of the tile
        const canonical = unwrappedTileID.canonical;
        const windowScaleFactor = 1 / this.height;
        const cws = this.cameraWorldSize;
        const scale = cws / this.zoomScale(canonical.z);
        const unwrappedX = canonical.x + Math.pow(2, canonical.z) * unwrappedTileID.wrap;
        const tX = unwrappedX * scale;
        const tY = canonical.y * scale;

        const center = this.point;
        // center is in world/pixel coordinate, ensure it's in the same coordinate space as tX and tY computed earlier.
        center.x *= cws / this.worldSize;
        center.y *= cws / this.worldSize;

        // Calculate the bearing vector by rotating unit vector [0, -1] clockwise
        const angle = this.angle;
        const bX = Math.sin(-angle);
        const bY = -Math.cos(-angle);

        const cX = (center.x - tX) * windowScaleFactor;
        const cY = (center.y - tY) * windowScaleFactor;
        cache[distanceDataKey] = {
            bearing: [bX, bY],
            center: [cX, cY],
            scale: (scale / EXTENT) * windowScaleFactor
        };

        return cache[distanceDataKey];
    }

    /**
     * Calculate the fogTileMatrix that, given a tile coordinate, can be used to
     * calculate its position relative to the camera in units of pixels divided
     * by the map height. Used with fog for consistent computation of distance
     * from camera.
     *
     * @param {UnwrappedTileID} unwrappedTileID;
     * @private
     */
    calculateFogTileMatrix(unwrappedTileID: UnwrappedTileID): mat4 {
        const fogTileMatrixKey = unwrappedTileID.key;
        const cache = this._fogTileMatrixCache;
        if (cache[fogTileMatrixKey]) {
            return cache[fogTileMatrixKey];
        }

        const posMatrix = this.projection.createTileMatrix(this, this.cameraWorldSizeForFog, unwrappedTileID);
        mat4.multiply(posMatrix, this.worldToFogMatrix, posMatrix);

        cache[fogTileMatrixKey] = new Float32Array(posMatrix);
        return cache[fogTileMatrixKey];
    }

    /**
     * Calculate the projMatrix that, given a tile coordinate, would be used to display the tile on the screen.
     * @param {UnwrappedTileID} unwrappedTileID;
     * @private
     */
    calculateProjMatrix(
        unwrappedTileID: UnwrappedTileID,
        aligned: boolean = false,
        expanded: boolean = false,
    ): mat4 {
        const projMatrixKey = unwrappedTileID.key;
        let cache: Record<number, mat4>;
        if (expanded) {
            cache = this._expandedProjMatrixCache;
        } else if (aligned) {
            cache = this._alignedProjMatrixCache;
        } else {
            cache = this._projMatrixCache;
        }
        if (cache[projMatrixKey]) {
            return cache[projMatrixKey];
        }

        const posMatrix = this.calculatePosMatrix(unwrappedTileID, this.worldSize);
        let projMatrix;
        if (this.projection.isReprojectedInTileSpace) {
            projMatrix = this.mercatorMatrix;
        } else if (expanded) {
            assert(!aligned);
            projMatrix = this.expandedFarZProjMatrix;
        } else {
            projMatrix = aligned ? this.alignedProjMatrix : this.projMatrix;
        }
        mat4.multiply(posMatrix, projMatrix, posMatrix);

        cache[projMatrixKey] = new Float32Array(posMatrix);
        return cache[projMatrixKey];
    }

    calculatePixelsToTileUnitsMatrix(tile: Tile): mat2 {
        const key = tile.tileID.key;
        const cache = this._pixelsToTileUnitsCache;
        if (cache[key]) {
            return cache[key];
        }

        const matrix = getPixelsToTileUnitsMatrix(tile, this);
        cache[key] = matrix;
        return cache[key];
    }

    customLayerMatrix(): mat4 {
        return this.mercatorMatrix.slice() as mat4;
    }

    globeToMercatorMatrix(): Array<number> | null | undefined {
        if (this.projection.name === 'globe') {
            const pixelsToMerc = 1 / this.worldSize;
            const m = mat4.fromScaling([] as unknown as mat4, [pixelsToMerc, pixelsToMerc, pixelsToMerc]);
            mat4.multiply(m, m, this.globeMatrix as unknown as mat4);
            return m as number[];
        }
        return undefined;
    }

    recenterOnTerrain() {
        if (!this._elevation || this.projection.name === 'globe')
            return;

        const elevation: Elevation = this._elevation;
        this._updateCameraState();

        // Cast a ray towards the sea level and find the intersection point with the terrain.
        // We need to use a camera position that exists in the same coordinate space as the data.
        // The default camera position might have been compensated by the active projection model.
        const mercPixelsPerMeter = mercatorZfromAltitude(1, this._center.lat) * this.worldSize;
        const start = this._computeCameraPosition(mercPixelsPerMeter);
        const dir = this._camera.forward();

        // The raycast function expects z-component to be in meters
        const metersToMerc = mercatorZfromAltitude(1.0, this._center.lat);
        start[2] /= metersToMerc;
        dir[2] /= metersToMerc;
        vec3.normalize(dir, dir);

        const t = elevation.raycast(start, dir, elevation.exaggeration());

        if (t) {
            const point = vec3.scaleAndAdd([] as unknown as vec3, start, dir, t);
            const newCenter = new MercatorCoordinate(point[0], point[1], mercatorZfromAltitude(point[2], latFromMercatorY(point[1])));

            const camToNew = [newCenter.x - start[0], newCenter.y - start[1], newCenter.z - start[2] * metersToMerc];
            const maxAltitude = (newCenter.z + vec3.length(camToNew as [number, number, number])) * this._pixelsPerMercatorPixel;
            this._seaLevelZoom = this._zoomFromMercatorZ(maxAltitude);

            // Camera zoom has to be updated as the orbit distance might have changed
            this._centerAltitude = newCenter.toAltitude();
            this._center = this.coordinateLocation(newCenter);
            this._updateZoomFromElevation();
            this._constrain();
            this._calcMatrices();
        }
    }

    _constrainCamera(adaptCameraAltitude: boolean = false) {
        if (!this._elevation)
            return;

        const elevation: Elevation = this._elevation;

        // Find uncompensated camera position for elevation sampling.
        // The default camera position might have been compensated by the active projection model.
        const mercPixelsPerMeter = mercatorZfromAltitude(1, this._center.lat) * this.worldSize;
        const pos = this._computeCameraPosition(mercPixelsPerMeter);
        const elevationAtCamera = elevation.getAtPointOrZero(new MercatorCoordinate(...pos));
        const terrainElevation = this.pixelsPerMeter / this.worldSize * elevationAtCamera;
        const minHeight = this._minimumHeightOverTerrain();
        const cameraHeight = pos[2] - terrainElevation;

        if (cameraHeight <= minHeight) {
            if (cameraHeight < 0 || adaptCameraAltitude) {
                const center = this.locationCoordinate(this._center, this._centerAltitude);
                const cameraToCenter = [pos[0], pos[1], center.z - pos[2]];

                const prevDistToCamera = vec3.length(cameraToCenter as [number, number, number]);
                // Adjust the camera vector so that the camera is placed above the terrain.
                // Distance between the camera and the center point is kept constant.
                cameraToCenter[2] -= (minHeight - cameraHeight) / this._pixelsPerMercatorPixel;
                const newDistToCamera = vec3.length(cameraToCenter as [number, number, number]);

                if (newDistToCamera === 0)
                    return;

                vec3.scale(cameraToCenter as [number, number, number], cameraToCenter as [number, number, number], prevDistToCamera / newDistToCamera * this._pixelsPerMercatorPixel);
                this._camera.position = [pos[0], pos[1], center.z * this._pixelsPerMercatorPixel - cameraToCenter[2]];
                this._updateStateFromCamera();
            } else {
                this._isCameraConstrained = true;
            }
        }
    }

    _constrain() {
        if (!this.center || !this.width || !this.height || this._constraining) return;

        this._constraining = true;
        const isGlobe = this.projection.name === 'globe' || this.mercatorFromTransition;

        // alternate constraining for non-Mercator projections
        if (this.projection.isReprojectedInTileSpace || isGlobe) {
            const center = this.center;
            center.lat = clamp(center.lat, this.minLat, this.maxLat);
            if (this.maxBounds || !(this.renderWorldCopies || isGlobe)) center.lng = clamp(center.lng, this.minLng, this.maxLng);
            this.center = center;
            this._constraining = false;
            return;
        }

        const unmodified = this._unmodified;
        const {x, y} = this.point;
        let s = 0;
        let x2 = x;
        let y2 = y;
        const w2 = this.width / 2;
        const h2 = this.height / 2;

        const minY = this.worldMinY * this.scale;
        const maxY = this.worldMaxY * this.scale;
        if (y - h2 < minY) y2 = minY + h2;
        if (y + h2 > maxY) y2 = maxY - h2;
        if (maxY - minY < this.height) {
            s = Math.max(s, this.height / (maxY - minY));
            y2 = (maxY + minY) / 2;
        }

        if (this.maxBounds || !this._renderWorldCopies || !this.projection.wrap) {
            const minX = this.worldMinX * this.scale;
            const maxX = this.worldMaxX * this.scale;

            // Translate to positive positions with the map center in the center position.
            // This ensures that the map snaps to the correct edge.
            const shift = this.worldSize / 2 - (minX + maxX) / 2;
            x2 = (x + shift + this.worldSize) % this.worldSize - shift;

            if (x2 - w2 < minX) x2 = minX + w2;
            if (x2 + w2 > maxX) x2 = maxX - w2;
            if (maxX - minX < this.width) {
                s = Math.max(s, this.width / (maxX - minX));
                x2 = (maxX + minX) / 2;
            }
        }

        if ((x2 !== x || y2 !== y) && !this._allowWorldUnderZoom) { // pan the map to fit the range
            this.center = this.unproject(new Point(x2, y2));
        }
        if (s && !this._allowWorldUnderZoom) { // scale the map to fit the range
            this.zoom += this.scaleZoom(s);
        }

        this._constrainCamera();
        this._unmodified = unmodified;
        this._constraining = false;
    }

    /**
     * Returns the minimum zoom at which `this.width` can fit max longitude range
     * and `this.height` can fit max latitude range.
     *
     * @returns {number} The zoom value.
     */
    _minZoomForBounds(): number {
        let minZoom = Math.max(0, this.scaleZoom(Math.max(0, this.height) / (this.worldMaxY - this.worldMinY)));
        if (this.maxBounds) {
            minZoom = Math.max(minZoom, this.scaleZoom(this.width / (this.worldMaxX - this.worldMinX)));
        }
        return minZoom;
    }

    /**
     * Returns the maximum distance of the camera from the center of the bounds, such that
     * `this.width` can fit max longitude range and `this.height` can fit max latitude range.
     * In mercator units.
     *
     * @returns {number} The mercator z coordinate.
     */
    _maxCameraBoundsDistance(): number {
        return this._mercatorZfromZoom(this._minZoomForBounds());
    }

    _calcMatrices(): void {
        if (!this.height) return;

        const offset = this.centerOffset;
        const isGlobe = this.projection.name === 'globe';

        // Z-axis uses pixel coordinates when globe mode is enabled
        const pixelsPerMeter = this.pixelsPerMeter;

        if (this.projection.name === 'globe') {
            this._mercatorScaleRatio = mercatorZfromAltitude(1, this.center.lat) / mercatorZfromAltitude(1, GLOBE_SCALE_MATCH_LATITUDE);
        }

        const projectionT = getProjectionInterpolationT(this.projection, this.zoom, this.width, this.height, 1024);

        // 'this._pixelsPerMercatorPixel' is the ratio between pixelsPerMeter in the current projection relative to Mercator.
        // This is useful for converting e.g. camera position between pixel spaces as some logic
        // such as raycasting expects the scale to be in mercator pixels
        this._pixelsPerMercatorPixel = this.projection.pixelSpaceConversion(this.center.lat, this.worldSize, projectionT);

        this.cameraToCenterDistance = 0.5 / Math.tan(this._fov * 0.5) * this.height * this._pixelsPerMercatorPixel;

        this._updateCameraState();

        this._farZ = this.projection.farthestPixelDistance(this);

        // The larger the value of nearZ is
        // - the more depth precision is available for features (good)
        // - clipping starts appearing sooner when the camera is close to 3d features (bad)
        //
        // Smaller values worked well for mapbox-gl-js but deckgl was encountering precision issues
        // when rendering it's layers using custom layers. This value was experimentally chosen and
        // seems to solve z-fighting issues in deckgl while not clipping buildings too close to the camera.
        this._nearZ = this.height / 50;

        const zUnit = this.projection.zAxisUnit === "meters" ? pixelsPerMeter : 1.0;
        const worldToCamera = this._camera.getWorldToCamera(this.worldSize, zUnit);

        let cameraToClip;

        const cameraToClipPerspective = this._camera.getCameraToClipPerspective(this._fov, this.width / this.height, this._nearZ, this._farZ);
        // Apply offset/padding
        cameraToClipPerspective[8] = -offset.x * 2 / this.width;
        cameraToClipPerspective[9] = offset.y * 2 / this.height;

        if (this.isOrthographic) {
            const cameraToCenterDistance =  0.5 * this.height / Math.tan(this._fov / 2.0) * 1.0;

            // Calculate bounds for orthographic view
            let top = cameraToCenterDistance * Math.tan(this._fov * 0.5);
            let right = top * this.aspect;
            let left = -right;
            let bottom = -top;
            // Apply offset/padding
            right -= offset.x;
            left -= offset.x;
            top += offset.y;
            bottom += offset.y;

            cameraToClip = this._camera.getCameraToClipOrthographic(left, right, bottom, top, this._nearZ, this._farZ);

            const mixValue =
                this.pitch >= OrthographicPitchTranstionValue ? 1.0 : this.pitch / OrthographicPitchTranstionValue;
            lerpMatrix(cameraToClip, cameraToClip, cameraToClipPerspective, easeIn(mixValue));
        } else {
            cameraToClip = cameraToClipPerspective;
        }

        const worldToClipPerspective = mat4.mul([] as unknown as mat4, cameraToClipPerspective, worldToCamera);
        let m = mat4.mul([] as unknown as mat4, cameraToClip, worldToCamera);

        if (this.projection.isReprojectedInTileSpace) {
            // Projections undistort as you zoom in (shear, scale, rotate).
            // Apply the undistortion around the center of the map.
            const mc = this.locationCoordinate(this.center);
            const adjustments = mat4.identity([] as unknown as mat4);
            mat4.translate(adjustments, adjustments, [mc.x * this.worldSize, mc.y * this.worldSize, 0]);
            mat4.multiply(adjustments, adjustments, getProjectionAdjustments(this) as mat4);
            mat4.translate(adjustments, adjustments, [-mc.x * this.worldSize, -mc.y * this.worldSize, 0]);
            mat4.multiply(m, m, adjustments);
            mat4.multiply(worldToClipPerspective, worldToClipPerspective, adjustments);
            this.inverseAdjustmentMatrix = getProjectionAdjustmentInverted(this);
        } else {
            this.inverseAdjustmentMatrix = [1, 0, 0, 1];
        }

        // The mercatorMatrix can be used to transform points from mercator coordinates
        // ([0, 0] nw, [1, 1] se) to GL coordinates. / zUnit compensates for scaling done in worldToCamera.
        this.mercatorMatrix = mat4.scale([] as unknown as mat4, m, [this.worldSize, this.worldSize, this.worldSize / zUnit, 1.0] as unknown as vec3);

        this.projMatrix = m;

        // For tile cover calculation, use inverted of base (non elevated) matrix
        // as tile elevations are in tile coordinates and relative to center elevation.
        this.invProjMatrix = mat4.invert(new Float64Array(16) as unknown as mat4, this.projMatrix);

        if (isGlobe) {
            const expandedCameraToClipPerspective = this._camera.getCameraToClipPerspective(this._fov, this.width / this.height, this._nearZ, Infinity);
            expandedCameraToClipPerspective[8] = -offset.x * 2 / this.width;
            expandedCameraToClipPerspective[9] = offset.y * 2 / this.height;
            this.expandedFarZProjMatrix = mat4.mul([] as unknown as mat4, expandedCameraToClipPerspective, worldToCamera);
        } else {
            this.expandedFarZProjMatrix = this.projMatrix;
        }

        const clipToCamera = mat4.invert([] as unknown as mat4, cameraToClip);
        this.frustumCorners = FrustumCorners.fromInvProjectionMatrix(clipToCamera, this.horizonLineFromTop(), this.height);

        // Create a camera frustum in mercator units
        this.cameraFrustum = Frustum.fromInvProjectionMatrix(this.invProjMatrix, this.worldSize, 0.0, !isGlobe);

        const view = new Float32Array(16);
        mat4.identity(view);
        mat4.scale(view, view, [1, -1, 1]);
        mat4.rotateX(view, view, this._pitch);
        mat4.rotateZ(view, view, this.angle);

        const projection = mat4.perspective(new Float32Array(16), this._fov, this.width / this.height, this._nearZ, this._farZ);

        this.starsProjMatrix = mat4.clone(projection);

        // The distance in pixels the skybox needs to be shifted down by to meet the shifted horizon.
        const skyboxHorizonShift = (Math.PI / 2 - this._pitch) * (this.height / this._fov) * this._horizonShift;
        // Apply center of perspective offset to skybox projection
        projection[8] = -offset.x * 2 / this.width;
        projection[9] = (offset.y + skyboxHorizonShift) * 2 / this.height;
        this.skyboxMatrix = mat4.multiply(view, projection, view);

        // Make a second projection matrix that is aligned to a pixel grid for rendering raster tiles.
        // We're rounding the (floating point) x/y values to achieve to avoid rendering raster images to fractional
        // coordinates. Additionally, we adjust by half a pixel in either direction in case that viewport dimension
        // is an odd integer to preserve rendering to the pixel grid. We're rotating this shift based on the angle
        // of the transformation so that 0°, 90°, 180°, and 270° rasters are crisp, and adjust the shift so that
        // it is always <= 0.5 pixels.
        const point = this.point;
        const x = point.x, y = point.y;
        const xShift = (this.width % 2) / 2, yShift = (this.height % 2) / 2,
            angleCos = Math.cos(this.angle), angleSin = Math.sin(this.angle),
            dx = x - Math.round(x) + angleCos * xShift + angleSin * yShift,
            dy = y - Math.round(y) + angleCos * yShift + angleSin * xShift;
        const alignedM = new Float64Array(m) as unknown as mat4;
        mat4.translate(alignedM, alignedM, [dx > 0.5 ? dx - 1 : dx, dy > 0.5 ? dy - 1 : dy, 0]);
        this.alignedProjMatrix = alignedM;

        m = mat4.create();
        mat4.scale(m, m, [this.width / 2, -this.height / 2, 1]);
        mat4.translate(m, m, [1, -1, 0]);
        this.labelPlaneMatrix = m;

        m = mat4.create();
        mat4.scale(m, m, [1, -1, 1]);
        mat4.translate(m, m, [-1, -1, 0]);
        mat4.scale(m, m, [2 / this.width, 2 / this.height, 1]);
        this.glCoordMatrix = m;

        // matrix for conversion from location to screen coordinates
        this.pixelMatrix = mat4.multiply(new Float64Array(16) as unknown as mat4, this.labelPlaneMatrix, worldToClipPerspective);

        this._calcFogMatrices();
        this._distanceTileDataCache = {};

        // inverse matrix for conversion from screen coordinates to location
        m = mat4.invert(new Float64Array(16) as unknown as mat4, this.pixelMatrix);
        if (!m) throw new Error("failed to invert matrix");
        this.pixelMatrixInverse = m;

        if (this.projection.name === 'globe' || this.mercatorFromTransition) {
            this.globeMatrix = calculateGlobeMatrix(this) as unknown as mat4;

            const globeCenter: [number, number, number] = [this.globeMatrix[12], this.globeMatrix[13], this.globeMatrix[14]];
            this.globeCenterInViewSpace = vec3.transformMat4(globeCenter, globeCenter, worldToCamera as unknown as mat4) as [number, number, number];
            this.globeRadius = this.worldSize / 2.0 / Math.PI - 1.0;
        } else {
            this.globeMatrix = m;
        }

        this._projMatrixCache = {};
        this._alignedProjMatrixCache = {};
        this._pixelsToTileUnitsCache = {};
        this._expandedProjMatrixCache = {};
    }

    _calcFogMatrices() {
        this._fogTileMatrixCache = {};

        const cameraWorldSizeForFog = this.cameraWorldSizeForFog;
        const cameraPixelsPerMeter = this.cameraPixelsPerMeter;
        const cameraPos = this._camera.position;

        // The mercator fog matrix encodes transformation necessary to transform a position to camera fog space (in meters):
        // translates p to camera origin and transforms it from pixels to meters. The windowScaleFactor is used to have a
        // consistent transformation across different window sizes.
        // - p = p - cameraOrigin
        // - p.xy = p.xy * cameraWorldSizeForFog * windowScaleFactor
        // - p.z  = p.z  * cameraPixelsPerMeter * windowScaleFactor
        const windowScaleFactor = 1 / this.height / this._pixelsPerMercatorPixel;
        const metersToPixel = [cameraWorldSizeForFog, cameraWorldSizeForFog, cameraPixelsPerMeter];
        vec3.scale(metersToPixel as [number, number, number], metersToPixel as [number, number, number], windowScaleFactor);
        vec3.scale(cameraPos, cameraPos, -1);
        vec3.multiply(cameraPos, cameraPos, metersToPixel as [number, number, number]);

        const m = mat4.create();
        mat4.translate(m, m, cameraPos);
        mat4.scale(m, m, metersToPixel as [number, number, number]);
        this.mercatorFogMatrix = m;

        // The worldToFogMatrix can be used for conversion from world coordinates to relative camera position in
        // units of fractions of the map height. Later composed with tile position to construct the fog tile matrix.
        this.worldToFogMatrix = this._camera.getWorldToCameraPosition(cameraWorldSizeForFog, cameraPixelsPerMeter, windowScaleFactor);
    }

    _computeCameraPosition(targetPixelsPerMeter?: number | null): [number, number, number] {
        targetPixelsPerMeter = targetPixelsPerMeter || this.pixelsPerMeter;
        const pixelSpaceConversion = targetPixelsPerMeter / this.pixelsPerMeter;

        const dir = this._camera.forward();
        const center = this.point;

        // Compute camera position using the following vector math: camera.position = map.center - camera.forward * cameraToCenterDist
        // Camera distance to the center can be found in mercator units by subtracting the center elevation from
        // camera's zenith position (which can be deduced from the zoom level)
        const zoom = this._seaLevelZoom ? this._seaLevelZoom : this._zoom;
        const altitude = this._mercatorZfromZoom(zoom) * pixelSpaceConversion;
        const distance = altitude - targetPixelsPerMeter / this.worldSize * this._centerAltitude;

        return [
            center.x / this.worldSize - dir[0] * distance,
            center.y / this.worldSize - dir[1] * distance,
            targetPixelsPerMeter / this.worldSize * this._centerAltitude - dir[2] * distance
        ];
    }

    _updateCameraState() {
        if (!this.height) return;

        // Set camera orientation and move it to a proper distance from the map
        this._camera.setPitchBearing(this._pitch, this.angle);
        this._camera.position = this._computeCameraPosition();
    }

    /**
     * Apply a 3d translation to the camera position, but clamping it so that
     * it respects the maximum longitude and latitude range set.
     *
     * @param {vec3} translation The translation vector.
     */
    _translateCameraConstrained(translation: vec3) {
        const maxDistance = this._maxCameraBoundsDistance();
        // Define a ceiling in mercator Z
        const maxZ = maxDistance * Math.cos(this._pitch);
        const z = this._camera.position[2];
        const deltaZ = translation[2];
        let t = 1;

        if (this.projection.wrap) this.center = this.center.wrap();

        // we only need to clamp if the camera is moving upwards
        if (deltaZ > 0) {
            t = Math.min((maxZ - z) / deltaZ, 1);
        }

        this._camera.position = vec3.scaleAndAdd([] as unknown as vec3, this._camera.position, translation, t);
        this._updateStateFromCamera();
    }

    _updateStateFromCamera() {
        const position = this._camera.position;
        const dir = this._camera.forward();
        const {pitch, bearing} = this._camera.getPitchBearing();

        // Compute zoom from the distance between camera and terrain
        const centerAltitude = mercatorZfromAltitude(this._centerAltitude, this.center.lat) * this._pixelsPerMercatorPixel;
        const minHeight = this._mercatorZfromZoom(this._maxZoom) * Math.cos(degToRad(this._maxPitch));
        const height = Math.max((position[2] - centerAltitude) / Math.cos(pitch), minHeight);
        const zoom = this._zoomFromMercatorZ(height);

        // Cast a ray towards the ground to find the center point
        vec3.scaleAndAdd(position, position, dir, height);

        this._pitch = clamp(pitch, degToRad(this.minPitch), degToRad(this.maxPitch));
        this.angle = wrap(bearing, -Math.PI, Math.PI);
        this._setZoom(clamp(zoom, this._minZoom, this._maxZoom));
        this._updateSeaLevelZoom();

        this._center = this.coordinateLocation(new MercatorCoordinate(position[0], position[1], position[2]));
        this._unmodified = false;
        this._constrain();
        this._calcMatrices();
    }

    _worldSizeFromZoom(zoom: number): number {
        return Math.pow(2.0, zoom) * this.tileSize;
    }

    _mercatorZfromZoom(zoom: number): number {
        return this.cameraToCenterDistance / this._worldSizeFromZoom(zoom);
    }

    _minimumHeightOverTerrain(): number {
        // Determine minimum height for the camera over the terrain related to current zoom.
        // Values above 4 allow camera closer to e.g. top of the hill, exposing
        // drape raster overscale artifacts or cut terrain (see under it) as it gets clipped on
        // near plane. Returned value is in mercator coordinates.
        const MAX_DRAPE_OVERZOOM = 4;
        const zoom = Math.min((this._seaLevelZoom != null ? this._seaLevelZoom : this._zoom), this._maxZoom) + MAX_DRAPE_OVERZOOM;
        return this._mercatorZfromZoom(zoom);
    }

    _zoomFromMercatorZ(z: number): number {
        return this.scaleZoom(this.cameraToCenterDistance / (Math.max(0, z) * this.tileSize));
    }

    // This function is helpful to approximate true zoom given a mercator height with varying ppm.
    // With Globe, since we use a fixed reference latitude at lower zoom levels and transition between this
    // latitude and the center's latitude as you zoom in, camera to center distance varies dynamically.
    // As the cameraToCenterDistance is a function of zoom, we need to approximate the true zoom
    // given a mercator meter value in order to eliminate the zoom/cameraToCenterDistance dependency.
    zoomFromMercatorZAdjusted(mercatorZ: number): number {
        assert(this.projection.name === 'globe');
        assert(mercatorZ !== 0);

        let zoomLow = 0;
        let zoomHigh = GLOBE_ZOOM_THRESHOLD_MAX;
        let zoom = 0;
        let minZoomDiff = Infinity;

        const epsilon = 1e-6;

        while (zoomHigh - zoomLow > epsilon && zoomHigh > zoomLow) {
            const zoomMid = zoomLow + (zoomHigh - zoomLow) * 0.5;

            const worldSize = this.tileSize * Math.pow(2, zoomMid);
            const d = this.getCameraToCenterDistance(this.projection, zoomMid, worldSize);
            const newZoom = this.scaleZoom(d / (Math.max(0, mercatorZ) * this.tileSize));

            const diff = Math.abs(zoomMid - newZoom);

            if (diff < minZoomDiff) {
                minZoomDiff = diff;
                zoom = zoomMid;
            }

            if (zoomMid < newZoom) {
                zoomLow = zoomMid;
            } else {
                zoomHigh = zoomMid;
            }
        }

        return zoom;
    }

    _terrainEnabled(): boolean {
        if (!this._elevation) return false;
        if (!this.projection.supportsTerrain) {
            warnOnce('Terrain is not yet supported with alternate projections. Use mercator or globe to enable terrain.');
            return false;
        }
        return true;
    }

    // Check if any of the four corners are off the edge of the rendered map
    // This function will return `false` for all non-mercator projection
    anyCornerOffEdge(p0: Point, p1: Point): boolean {
        const minX = Math.min(p0.x, p1.x);
        const maxX = Math.max(p0.x, p1.x);
        const minY = Math.min(p0.y, p1.y);
        const maxY = Math.max(p0.y, p1.y);

        const horizon = this.horizonLineFromTop(false);
        if (minY < horizon) return true;

        if (this.projection.name !== 'mercator') {
            return false;
        }

        const min = new Point(minX, minY);
        const max = new Point(maxX, maxY);

        const corners = [
            min, max,
            new Point(minX, maxY),
            new Point(maxX, minY),
        ];

        const minWX = (this.renderWorldCopies) ? -NUM_WORLD_COPIES : 0;
        const maxWX = (this.renderWorldCopies) ? 1 + NUM_WORLD_COPIES : 1;
        const minWY = 0;
        const maxWY = 1;

        for (const corner of corners) {
            const rayIntersection = this.pointRayIntersection(corner);
            // Point is above the horizon
            if (rayIntersection.t < 0) {
                return true;
            }
            // Point is off the bondaries of the map
            const coordinate = this.rayIntersectionCoordinate(rayIntersection);
            if (coordinate.x < minWX || coordinate.y < minWY ||
                coordinate.x > maxWX || coordinate.y > maxWY) {
                return true;
            }
        }

        return false;
    }

    // Checks the four corners of the frustum to see if they lie in the map's quad.
    //
    isHorizonVisible(): boolean {

        // we consider the horizon as visible if the angle between
        // a the top plane of the frustum and the map plane is smaller than this threshold.
        const horizonAngleEpsilon = 2;
        if (this.pitch + radToDeg(this.fovAboveCenter) > (90 - horizonAngleEpsilon)) {
            return true;
        }

        return this.anyCornerOffEdge(new Point(0, 0), new Point(this.width, this.height));
    }

    /**
     * Converts a zoom delta value into a physical distance travelled in web mercator coordinates.
     *
     * @param {vec3} center Destination mercator point of the movement.
     * @param {number} zoomDelta Change in the zoom value.
     * @returns {number} The distance in mercator coordinates.
     */
    zoomDeltaToMovement(center: vec3, zoomDelta: number): number {
        const distance = vec3.length(vec3.sub([] as unknown as vec3, this._camera.position, center));
        const relativeZoom = this._zoomFromMercatorZ(distance) + zoomDelta;
        return distance - this._mercatorZfromZoom(relativeZoom);
    }

    /*
     * The camera looks at the map from a 3D (lng, lat, altitude) location. Let's use `cameraLocation`
     * as the name for the location under the camera and on the surface of the earth (lng, lat, 0).
     * `cameraPoint` is the projected position of the `cameraLocation`.
     *
     * This point is useful to us because only fill-extrusions that are between `cameraPoint` and
     * the query point on the surface of the earth can extend and intersect the query.
     *
     * When the map is not pitched the `cameraPoint` is equivalent to the center of the map because
     * the camera is right above the center of the map.
     */
    getCameraPoint(): Point {
        if (this.projection.name === 'globe') {
            // Find precise location of the projected camera position on the curved surface
            const center: vec3 = [this.globeMatrix[12], this.globeMatrix[13], this.globeMatrix[14]];
            const pos = projectClamped(center, this.pixelMatrix);
            return new Point(pos[0], pos[1]);
        } else {
            const pitch = this._pitch;
            const yOffset = Math.tan(pitch) * (this.cameraToCenterDistance || 1);
            return this.centerPoint.add(new Point(0, yOffset));
        }
    }

    getCameraToCenterDistance(
        projection: Projection,
        zoom: number = this.zoom,
        worldSize: number = this.worldSize,
    ): number {
        const t = getProjectionInterpolationT(projection, zoom, this.width, this.height, 1024);
        const projectionScaler = projection.pixelSpaceConversion(this.center.lat, worldSize, t);
        let distance =  0.5 / Math.tan(this._fov * 0.5) * this.height * projectionScaler;

        // In case we have orthographic transition we need to interpolate the distance value in the range [1, distance]
        // to calculate correct perspective ratio values for symbols
        if (this.isOrthographic) {
            const mixValue = this.pitch >= OrthographicPitchTranstionValue ? 1.0 : this.pitch / OrthographicPitchTranstionValue;
            distance = interpolate(1.0, distance, easeIn(mixValue));
        }
        return distance;
    }

    getWorldToCameraMatrix(): mat4 {
        const zUnit = this.projection.zAxisUnit === "meters" ? this.pixelsPerMeter : 1.0;
        const worldToCamera = this._camera.getWorldToCamera(this.worldSize, zUnit);

        if (this.projection.name === 'globe') {
            mat4.multiply(worldToCamera, worldToCamera, this.globeMatrix);
        }

        return worldToCamera;
    }

    getFrustum(zoom: number): Frustum {
        const zInMeters = this.projection.zAxisUnit === 'meters';
        return Frustum.fromInvProjectionMatrix(this.invProjMatrix, this.worldSize, zoom, zInMeters);
    }
}

export default Transform;
