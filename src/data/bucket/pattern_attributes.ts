import {createLayout} from '../../util/struct_array';

import type {StructArrayLayout} from '../../util/struct_array';

export const patternAttributes: StructArrayLayout = createLayout([
    // [tl.x, tl.y, br.x, br.y]
    {name: 'a_pattern', components: 4, type: 'Uint16'},
    {name: 'a_pixel_ratio', components: 1, type: 'Float32'}
]);

export const patternTransitionAttributes: StructArrayLayout = createLayout([
    // [tl.x, tl.y, br.x, br.y]
    {name: 'a_pattern_b', components: 4, type: 'Uint16'},
]);
