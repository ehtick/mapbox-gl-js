type GridItem = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    key: any;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

/**
 * GridIndex is a data structure for testing the intersection of
 * circles and rectangles in a 2d plane.
 * It is optimized for rapid insertion and querying.
 * GridIndex splits the plane into a set of "cells" and keeps track
 * of which geometries intersect with each cell. At query time,
 * full geometry comparisons are only done for items that share
 * at least one cell. As long as the geometries are relatively
 * uniformly distributed across the plane, this greatly reduces
 * the number of comparisons necessary.
 *
 * @private
 */
class GridIndex {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    circleKeys: Array<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boxKeys: Array<any>;
    boxCells: Array<Array<number>>;
    circleCells: Array<Array<number>>;
    bboxes: Array<number>;
    circles: Array<number>;
    xCellCount: number;
    yCellCount: number;
    width: number;
    height: number;
    xScale: number;
    yScale: number;
    boxUid: number;
    circleUid: number;

    constructor(width: number, height: number, cellSize: number) {
        const boxCells = this.boxCells = [];
        const circleCells = this.circleCells = [];

        // More cells -> fewer geometries to check per cell, but items tend
        // to be split across more cells.
        // Sweet spot allows most small items to fit in one cell
        this.xCellCount = Math.ceil(width / cellSize);
        this.yCellCount = Math.ceil(height / cellSize);

        for (let i = 0; i < this.xCellCount * this.yCellCount; i++) {
            boxCells.push([]);
            circleCells.push([]);
        }
        this.circleKeys = [];
        this.boxKeys = [];
        this.bboxes = [];
        this.circles = [];

        this.width = width;
        this.height = height;
        this.xScale = this.xCellCount / width;
        this.yScale = this.yCellCount / height;
        this.boxUid = 0;
        this.circleUid = 0;
    }

    keysLength(): number {
        return this.boxKeys.length + this.circleKeys.length;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert(key: any, x1: number, y1: number, x2: number, y2: number) {
        this._forEachCell(x1, y1, x2, y2, this._insertBoxCell, this.boxUid++);
        this.boxKeys.push(key);
        this.bboxes.push(x1);
        this.bboxes.push(y1);
        this.bboxes.push(x2);
        this.bboxes.push(y2);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertCircle(key: any, x: number, y: number, radius: number) {
        // Insert circle into grid for all cells in the circumscribing square
        // It's more than necessary (by a factor of 4/PI), but fast to insert
        this._forEachCell(x - radius, y - radius, x + radius, y + radius, this._insertCircleCell, this.circleUid++);
        this.circleKeys.push(key);
        this.circles.push(x);
        this.circles.push(y);
        this.circles.push(radius);
    }

    _insertBoxCell(x1: number, y1: number, x2: number, y2: number, cellIndex: number, uid: number) {
        this.boxCells[cellIndex].push(uid);
    }

    _insertCircleCell(x1: number, y1: number, x2: number, y2: number, cellIndex: number, uid: number)  {
        this.circleCells[cellIndex].push(uid);
    }

    _query(
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        hitTest: boolean,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        predicate?: any,
    ): boolean | Array<GridItem> {
        if (x2 < 0 || x1 > this.width || y2 < 0 || y1 > this.height) {
            return hitTest ? false : [];
        }
        const result = [];
        if (x1 <= 0 && y1 <= 0 && this.width <= x2 && this.height <= y2) {
            if (hitTest) {
                return true;
            }
            for (let boxUid = 0; boxUid < this.boxKeys.length; boxUid++) {
                result.push({
                    key: this.boxKeys[boxUid],
                    x1: this.bboxes[boxUid * 4],
                    y1: this.bboxes[boxUid * 4 + 1],
                    x2: this.bboxes[boxUid * 4 + 2],
                    y2: this.bboxes[boxUid * 4 + 3]
                });
            }
            for (let circleUid = 0; circleUid < this.circleKeys.length; circleUid++) {
                const x = this.circles[circleUid * 3];
                const y = this.circles[circleUid * 3 + 1];
                const radius = this.circles[circleUid * 3 + 2];
                result.push({
                    key: this.circleKeys[circleUid],
                    x1: x - radius,
                    y1: y - radius,
                    x2: x + radius,
                    y2: y + radius
                });
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return predicate ? result.filter(predicate) : result;
        } else {
            const queryArgs = {
                hitTest,
                seenUids: {box: {}, circle: {}}
            };
            this._forEachCell(x1, y1, x2, y2, this._queryCell, result, queryArgs, predicate);
            return hitTest ? result.length > 0 : result;
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _queryCircle(x: number, y: number, radius: number, hitTest: boolean, predicate?: any): boolean | Array<GridItem> {
        // Insert circle into grid for all cells in the circumscribing square
        // It's more than necessary (by a factor of 4/PI), but fast to insert
        const x1 = x - radius;
        const x2 = x + radius;
        const y1 = y - radius;
        const y2 = y + radius;
        if (x2 < 0 || x1 > this.width || y2 < 0 || y1 > this.height) {
            return hitTest ? false : [];
        }

        // Box query early exits if the bounding box is larger than the grid, but we don't do
        // the equivalent calculation for circle queries because early exit is less likely
        // and the calculation is more expensive
        const result = [];
        const queryArgs = {
            hitTest,
            circle: {x, y, radius},
            seenUids: {box: {}, circle: {}}
        };
        this._forEachCell(x1, y1, x2, y2, this._queryCellCircle, result, queryArgs, predicate);
        return hitTest ? result.length > 0 : result;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query(x1: number, y1: number, x2: number, y2: number, predicate?: any): Array<GridItem> {

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
        return this._query(x1, y1, x2, y2, false, predicate) as any;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hitTest(x1: number, y1: number, x2: number, y2: number, predicate?: any): boolean {

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
        return this._query(x1, y1, x2, y2, true, predicate) as any;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hitTestCircle(x: number, y: number, radius: number, predicate?: any): boolean {

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
        return this._queryCircle(x, y, radius, true, predicate) as any;
    }

    _queryCell(
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        cellIndex: number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        queryArgs: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        predicate?: any,
    ): void | boolean {
        const seenUids = queryArgs.seenUids;
        const boxCell = this.boxCells[cellIndex];
        if (boxCell !== null) {
            const bboxes = this.bboxes;
            for (const boxUid of boxCell) {
                if (!seenUids.box[boxUid]) {
                    seenUids.box[boxUid] = true;
                    const offset = boxUid * 4;
                    if ((x1 <= bboxes[offset + 2]) &&
                        (y1 <= bboxes[offset + 3]) &&
                        (x2 >= bboxes[offset + 0]) &&
                        (y2 >= bboxes[offset + 1]) &&
                        (!predicate || predicate(this.boxKeys[boxUid]))) {
                        if (queryArgs.hitTest) {
                            result.push(true);
                            return true;
                        } else {
                            result.push({
                                key: this.boxKeys[boxUid],
                                x1: bboxes[offset],
                                y1: bboxes[offset + 1],
                                x2: bboxes[offset + 2],
                                y2: bboxes[offset + 3]
                            });
                        }
                    }
                }
            }
        }
        const circleCell = this.circleCells[cellIndex];
        if (circleCell !== null) {
            const circles = this.circles;
            for (const circleUid of circleCell) {
                if (!seenUids.circle[circleUid]) {
                    seenUids.circle[circleUid] = true;
                    const offset = circleUid * 3;
                    if (this._circleAndRectCollide(
                        circles[offset],
                        circles[offset + 1],
                        circles[offset + 2],
                        x1,
                        y1,
                        x2,
                        y2) &&
                        (!predicate || predicate(this.circleKeys[circleUid]))) {
                        if (queryArgs.hitTest) {
                            result.push(true);
                            return true;
                        } else {
                            const x = circles[offset];
                            const y = circles[offset + 1];
                            const radius = circles[offset + 2];
                            result.push({
                                key: this.circleKeys[circleUid],
                                x1: x - radius,
                                y1: y - radius,
                                x2: x + radius,
                                y2: y + radius
                            });
                        }
                    }
                }
            }
        }
    }

    _queryCellCircle(
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        cellIndex: number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        queryArgs: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        predicate?: any,
    ): void | boolean {
        const circle = queryArgs.circle;
        const seenUids = queryArgs.seenUids;
        const boxCell = this.boxCells[cellIndex];
        if (boxCell !== null) {
            const bboxes = this.bboxes;
            for (const boxUid of boxCell) {
                if (!seenUids.box[boxUid]) {
                    seenUids.box[boxUid] = true;
                    const offset = boxUid * 4;
                    if (this._circleAndRectCollide(
                        circle.x,
                        circle.y,
                        circle.radius,
                        bboxes[offset + 0],
                        bboxes[offset + 1],
                        bboxes[offset + 2],
                        bboxes[offset + 3]) &&
                        (!predicate || predicate(this.boxKeys[boxUid]))) {
                        result.push(true);
                        return true;
                    }
                }
            }
        }

        const circleCell = this.circleCells[cellIndex];
        if (circleCell !== null) {
            const circles = this.circles;
            for (const circleUid of circleCell) {
                if (!seenUids.circle[circleUid]) {
                    seenUids.circle[circleUid] = true;
                    const offset = circleUid * 3;
                    if (this._circlesCollide(
                        circles[offset],
                        circles[offset + 1],
                        circles[offset + 2],
                        circle.x,
                        circle.y,
                        circle.radius) &&
                        (!predicate || predicate(this.circleKeys[circleUid]))) {
                        result.push(true);
                        return true;
                    }
                }
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _forEachCell(x1: number, y1: number, x2: number, y2: number, fn: any, arg1: any, arg2?: any, predicate?: any) {
        const cx1 = this._convertToXCellCoord(x1);
        const cy1 = this._convertToYCellCoord(y1);
        const cx2 = this._convertToXCellCoord(x2);
        const cy2 = this._convertToYCellCoord(y2);

        for (let x = cx1; x <= cx2; x++) {
            for (let y = cy1; y <= cy2; y++) {
                const cellIndex = this.xCellCount * y + x;
                if (fn.call(this, x1, y1, x2, y2, cellIndex, arg1, arg2, predicate)) return;
            }
        }
    }

    _convertToXCellCoord(x: number): number {
        return Math.max(0, Math.min(this.xCellCount - 1, Math.floor(x * this.xScale)));
    }

    _convertToYCellCoord(y: number): number {
        return Math.max(0, Math.min(this.yCellCount - 1, Math.floor(y * this.yScale)));
    }

    _circlesCollide(x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): boolean {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const bothRadii = r1 + r2;
        return (bothRadii * bothRadii) > (dx * dx + dy * dy);
    }

    _circleAndRectCollide(
        circleX: number,
        circleY: number,
        radius: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
    ): boolean {
        const halfRectWidth = (x2 - x1) / 2;
        const distX = Math.abs(circleX - (x1 + halfRectWidth));
        if (distX > (halfRectWidth + radius)) {
            return false;
        }

        const halfRectHeight = (y2 - y1) / 2;
        const distY = Math.abs(circleY - (y1 + halfRectHeight));
        if (distY > (halfRectHeight + radius)) {
            return false;
        }

        if (distX <= halfRectWidth || distY <= halfRectHeight) {
            return true;
        }

        const dx = distX - halfRectWidth;
        const dy = distY - halfRectHeight;
        return (dx * dx + dy * dy <= (radius * radius));
    }
}

export default GridIndex;
