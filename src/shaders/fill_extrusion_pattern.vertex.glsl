#include "_prelude_fog.vertex.glsl"
#include "_prelude_terrain.vertex.glsl"
#include "_prelude_lighting.glsl"

uniform mat4 u_matrix;
uniform vec2 u_pixel_coord_upper;
uniform vec2 u_pixel_coord_lower;
uniform float u_height_factor;
uniform float u_tile_units_to_pixels;
uniform float u_vertical_gradient;
uniform lowp float u_opacity;
uniform float u_width_scale;

uniform vec3 u_lightcolor;
uniform lowp vec3 u_lightpos;
uniform lowp float u_lightintensity;

in vec4 a_pos_normal_ed;
in vec2 a_centroid_pos;

#ifdef RENDER_WALL_MODE
in vec3 a_join_normal_inside;
#endif

#ifdef PROJECTION_GLOBE_VIEW
in vec3 a_pos_3;         // Projected position on the globe
in vec3 a_pos_normal_3;  // Surface normal at the position

uniform mat4 u_inv_rot_matrix;
uniform vec2 u_merc_center;
uniform vec3 u_tile_id;
uniform float u_zoom_transition;
uniform vec3 u_up_dir;
uniform float u_height_lift;
#endif

#ifdef TERRAIN
uniform int u_height_type;
uniform int u_base_type;
#endif

out highp vec2 v_pos;
out vec4 v_lighting;

#ifdef FAUX_AO
uniform lowp vec2 u_ao;
out vec3 v_ao;
#endif

#ifdef LIGHTING_3D_MODE
out vec3 v_normal;
#endif

#pragma mapbox: define highp float base
#pragma mapbox: define highp float height
#pragma mapbox: define highp vec4 color
#pragma mapbox: define mediump vec4 pattern
#ifdef FILL_EXTRUSION_PATTERN_TRANSITION
#pragma mapbox: define mediump vec4 pattern_b
#endif
#pragma mapbox: define highp float pixel_ratio
#pragma mapbox: define highp float line_width

void main() {
    #pragma mapbox: initialize highp float base
    #pragma mapbox: initialize highp float height
    #pragma mapbox: initialize highp vec4 color
    #pragma mapbox: initialize mediump vec4 pattern
    #ifdef FILL_EXTRUSION_PATTERN_TRANSITION
    #pragma mapbox: initialize mediump vec4 pattern_b
    #endif
    #pragma mapbox: initialize highp float pixel_ratio
    #pragma mapbox: initialize highp float line_width

    vec2 pattern_tl = pattern.xy;
    vec2 pattern_br = pattern.zw;

    vec4 pos_nx = floor(a_pos_normal_ed * 0.5);
    // The least significant bits of a_pos_normal_ed.xy hold:
    // x is 1 if it's on top, 0 for ground.
    // y is 1 if the normal points up, and 0 if it points to side.
    // z is sign of ny: 1 for positive, 0 for values <= 0.
    // w marks edge's start, 0 is for edge end, edgeDistance increases from start to end.
    mediump vec4 top_up_ny_start = a_pos_normal_ed - 2.0 * pos_nx;
    mediump vec3 top_up_ny = top_up_ny_start.xyz;

    float x_normal = pos_nx.z / 8192.0;
    vec3 normal = top_up_ny.y == 1.0 ? vec3(0.0, 0.0, 1.0) : normalize(vec3(x_normal, (2.0 * top_up_ny.z - 1.0) * (1.0 - abs(x_normal)), 0.0));
    float edgedistance = a_pos_normal_ed.w;

    vec2 display_size = (pattern_br - pattern_tl) / pixel_ratio;

    base = max(0.0, base);
    height = max(0.0, height);

    float t = top_up_ny.x;
    float z = t > 0.0 ? height : base;

    vec2 centroid_pos = vec2(0.0);
#if defined(HAS_CENTROID) || defined(TERRAIN)
    centroid_pos = a_centroid_pos;
#endif

    float ele = 0.0;
    float h = z;
    vec3 p;
    float c_ele;
#ifdef TERRAIN
    bool is_flat_height = centroid_pos.x != 0.0 && u_height_type == 1;
    bool is_flat_base = centroid_pos.x != 0.0 && u_base_type == 1;
    ele = elevation(pos_nx.xy);
    c_ele = is_flat_height || is_flat_base ? (centroid_pos.y == 0.0 ? elevationFromUint16(centroid_pos.x) : flatElevation(centroid_pos)) : ele;
    float h_height = is_flat_height ? max(c_ele + height, ele + base + 2.0) : ele + height;
    float h_base = is_flat_base ? max(c_ele + base, ele + base) : ele + (base == 0.0 ? -5.0 : base);
    h = t > 0.0 ? max(h_base, h_height) : h_base;
    p = vec3(pos_nx.xy, h);
#else
    p = vec3(pos_nx.xy, z);
#endif

#ifdef PROJECTION_GLOBE_VIEW
    // If t > 0 (top) we always add the lift, otherwise (ground) we only add it if base height is > 0
    float lift = float((t + base) > 0.0) * u_height_lift;
    h += lift;
    vec3 globe_normal = normalize(mix(a_pos_normal_3 / 16384.0, u_up_dir, u_zoom_transition));
    vec3 globe_pos = a_pos_3 + globe_normal * (u_tile_up_scale * (p.z + lift));
    vec3 merc_pos = mercator_tile_position(u_inv_rot_matrix, p.xy, u_tile_id, u_merc_center) + u_up_dir * u_tile_up_scale * p.z;
    p = mix_globe_mercator(globe_pos, merc_pos, u_zoom_transition);
#endif

#ifdef RENDER_WALL_MODE
    vec2 wall_offset = u_width_scale * line_width * (a_join_normal_inside.xy / EXTENT);
    p.xy += (1.0 - a_join_normal_inside.z) * wall_offset * 0.5;
    p.xy -= a_join_normal_inside.z * wall_offset * 0.5;
#endif
    float hidden = float((centroid_pos.x == 0.0 && centroid_pos.y == 1.0) || (color.a == 0.0));
    gl_Position = mix(u_matrix * vec4(p, 1), AWAY, hidden);

    vec2 pos = normal.z == 1.0
        ? pos_nx.xy // extrusion top
        : vec2(edgedistance, z * u_height_factor); // extrusion side

    v_pos = get_pattern_pos(u_pixel_coord_upper, u_pixel_coord_lower, display_size, u_tile_units_to_pixels, pos);

    v_lighting = vec4(0.0, 0.0, 0.0, 1.0);
    float NdotL = 0.0;
#ifdef LIGHTING_3D_MODE
    NdotL = calculate_NdotL(normal);
#else
    NdotL = clamp(dot(normal, u_lightpos), 0.0, 1.0);
    NdotL = mix((1.0 - u_lightintensity), max((0.5 + u_lightintensity), 1.0), NdotL);
#endif

    if (normal.y != 0.0) {
        float r = 0.84;
#ifndef LIGHTING_3D_MODE
        r = mix(0.7, 0.98, 1.0 - u_lightintensity);
#endif
        // This avoids another branching statement, but multiplies by a constant of 0.84 if no vertical gradient,
        // and otherwise calculates the gradient based on base + height
        NdotL *= (
            (1.0 - u_vertical_gradient) +
            (u_vertical_gradient * clamp((t + base) * pow(height / 150.0, 0.5), r, 1.0)));
    }

#ifdef FAUX_AO
    // Documented at https://github.com/mapbox/mapbox-gl-js/pull/11926#discussion_r898496259
    float concave = pos_nx.w - floor(pos_nx.w * 0.5) * 2.0;
    float start = top_up_ny_start.w;
    float y_ground = 1.0 - clamp(t + base, 0.0, 1.0);
    float top_height = height;
#ifdef TERRAIN
    top_height = mix(max(c_ele + height, ele + base + 2.0), ele + height, float(centroid_pos.x == 0.0)) - ele;
    y_ground += y_ground * 5.0 / max(3.0, top_height);
#endif
    v_ao = vec3(mix(concave, -concave, start), y_ground, h - ele);
    NdotL *= (1.0 + 0.05 * (1.0 - top_up_ny.y) * u_ao[0]); // compensate sides faux ao shading contribution

#ifdef PROJECTION_GLOBE_VIEW
    top_height += u_height_lift;
#endif
    gl_Position.z -= (0.0000006 * (min(top_height, 500.) + 2.0 * min(base, 500.0) + 60.0 * concave + 3.0 * start)) * gl_Position.w;
#endif

#ifdef LIGHTING_3D_MODE
    v_normal = normal;
#else
    v_lighting.rgb += clamp(NdotL * u_lightcolor, mix(vec3(0.0), vec3(0.3), 1.0 - u_lightcolor), vec3(1.0));
    v_lighting *= u_opacity;
#endif

#ifdef FOG
    v_fog_pos = fog_position(p);
#endif
}
