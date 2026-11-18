// Every record and path vertex goes through this one shader, branching on the record's kind, so
// shapes, glyphs, images and paths share draw calls. Shapes are signed distance fields
// antialiased from their screen-space derivatives, or blurred by an erf edge when they have
// softness. Output is premultiplied, in the target's encoding.

#include "interface.hlsli"

// Abramowitz and Stegun 7.1.26, within 1.5e-7: a Gaussian-blurred straight edge is exactly this,
// and a blurred corner close enough to it that nobody can tell.
float erf_approx(float x) {
    float s = sign(x);
    float a = abs(x);
    float t = 1.0f / (1.0f + 0.3275911f * a);
    float y = 1.0f
              - (((((1.061405429f * t - 1.453152027f) * t) + 1.421413741f) * t - 0.284496736f) * t
                 + 0.254829592f)
                    * t * exp(-a * a);
    return s * y;
}

// A hash of a whole pixel position: grain that stays put under its pixel.
float noise(float2 pixel) {
    float3 p = frac(float3(pixel.xyx) * 0.1031f);
    p += dot(p, p.yzx + 33.33f);
    return frac((p.x + p.y) * p.z);
}

// An arc band of the given centre radius and half width, swept half_sweep either side of +x.
// Its ends are round: past them the distance is to the end point.
float arc_band(float2 p, float radius, float half_band, float half_sweep) {
    float2 q = float2(p.x, abs(p.y));
    float2 end = float2(cos(half_sweep), sin(half_sweep));
    bool is_past_end = q.y * end.x > q.x * end.y;
    float to_end = length(q - end * radius);
    float to_band = abs(length(q) - radius);
    return (is_past_end ? to_end : to_band) - half_band;
}

// A segment from -half_vector to +half_vector, half_width either side of it.
float segment_band(float2 p, float2 half_vector, float half_width, bool is_round) {
    float extent = length(half_vector);
    // A zero vector is a dot: along stays zero rather than dividing by it.
    float along = clamp(dot(p, half_vector) / max(extent * extent, 1e-12f), -1.0f, 1.0f);
    float rounded = length(p - half_vector * along) - half_width;
    float2 axis = half_vector / max(extent, 1e-6f);
    float2 q = abs(float2(dot(p, axis), dot(p, float2(-axis.y, axis.x)))) - float2(extent, half_width);
    float butt = length(max(q, 0.0f)) + min(max(q.x, q.y), 0.0f);
    return is_round ? rounded : butt;
}

float inside(float2 pixel, float4 rect) {
    return all(pixel >= rect.xy) && all(pixel < rect.zw) ? 1.0f : 0.0f;
}

float2 uv_of(float2 pixel, quad_record shape) {
    float2 t = (pixel - shape.rect.xy) / max(shape.rect.zw - shape.rect.xy, 1e-6f);
    return lerp(shape.geometry.xy, shape.geometry.zw, t);
}

float4 paint_of(quad_record shape, uint paint, float2 pixel) {
    float4 from = premultiplied(unpack_color(shape.style.x));
    float4 to = premultiplied(unpack_color(shape.style.y));
    float2 start = shape.gradient.xy;
    float2 along = shape.gradient.zw - start;
    float t = saturate(dot(pixel - start, along) / max(dot(along, along), 1e-6f));
    float4 color = from;
    if (paint == paint_kind_linear) {
        color = lerp(from, to, t);
    } else if (paint == paint_kind_noise) {
        color = from * noise(floor(pixel));
    }
    return color;
}

// The signed distance to a shape record's edge, in pixels: negative inside.
float distance_of(quad_record shape, float2 pixel) {
    uint kinds = shape.style.z;
    uint kind = kinds & quad_kind_mask;
    float2 p = pixel - (shape.rect.xy + shape.rect.zw) * 0.5f;
    float distance = 0.0f;
    if (kind == quad_kind_arc) {
        float mid = shape.geometry.w;
        float2 turned = float2(p.x * cos(mid) + p.y * sin(mid), p.y * cos(mid) - p.x * sin(mid));
        distance = arc_band(turned, shape.geometry.x, shape.geometry.y, shape.geometry.z);
    } else if (kind == quad_kind_segment) {
        distance = segment_band(p, shape.geometry.xy, shape.geometry.z, (kinds & round_cap_bit) != 0);
    } else {
        float stroke = f16tof32(shape.style.w >> 16);
        float2 half_size = (shape.rect.zw - shape.rect.xy) * 0.5f;
        distance = rounded_box(p, half_size, shape.geometry);
        if (stroke > 0.0f) {
            // A band inside the edge, so a stroked and a filled shape of the same bounds cover the
            // same pixels.
            distance = abs(distance + stroke * 0.5f) - stroke * 0.5f;
        }
    }
    return distance;
}

float coverage_of(float distance, float softness, float2 pixel) {
    // One screen pixel measured in the field's space, from the position's screen-space derivatives,
    // not the distance's: a 2x2 quad straddling a box's medial axis sees the distance turn there, and
    // its coarse derivatives would call the corner pixel 1.4 pixels wide.
    float pixel_size = max(0.5f * (length(ddx(pixel)) + length(ddy(pixel))), 1e-4f);
    float crisp = saturate(0.5f - distance / pixel_size);
    float soft = 0.5f - 0.5f * erf_approx(distance / (max(softness, 1e-4f) * 1.41421356f));
    return softness > 0.0f ? soft : crisp;
}

float4 shade(quad_record shape, float2 pixel) {
    uint kinds = shape.style.z;
    uint kind = kinds & quad_kind_mask;
    uint paint = (kinds >> paint_kind_shift) & paint_kind_mask;
    float softness = f16tof32(shape.style.w & 0xffff);
    float4 color = paint_of(shape, paint, pixel);
    float coverage = coverage_of(distance_of(shape, pixel), softness, pixel);
    if (kind == quad_kind_atlas) {
        float width = 0.0f;
        float height = 0.0f;
        float pages = 0.0f;
        atlas.GetDimensions(width, height, pages);
        float page = (float)(kinds >> atlas_page_shift);
        float3 at = float3(uv_of(pixel, shape) / float2(width, height), page);
        coverage = atlas.SampleLevel(linear_clamp, at, 0.0f) * inside(pixel, shape.rect);
    } else if (kind == quad_kind_image) {
        color *= image.SampleLevel(linear_clamp, uv_of(pixel, shape), 0.0f);
        coverage = inside(pixel, shape.rect);
    }
    return color * coverage;
}

float4 main(pixel_input input) : SV_Target {
    float4 color = input.record == path_record ? premultiplied(input.color)
                                               : shade(records[input.record], input.pixel);
    color *= mask_of(input.pixel);
    // An _SRGB target blends linear values and encodes them itself.
    if (frame.target.z > 0.5f && color.a > 0.0f) {
        color.rgb = linear_from_srgb(color.rgb / color.a) * color.a;
    }
    return color;
}
