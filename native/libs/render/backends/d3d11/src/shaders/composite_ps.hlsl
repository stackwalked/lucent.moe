// Puts a layer's blurred backdrop, or its contents drawn aside, back under its rounded mask, at its
// opacity. Inside the rim the backdrop is sampled from a little outside the edge, outward along the
// edge's normal, and lifted, the way a bevel bends light.

#include "interface.hlsli"

// How far the rim pulls its samples outward at the very edge, as a fraction of its width.
static const float rim_pull = 0.5f;
// How much brighter the backdrop is at the very edge.
static const float rim_lift = 0.3f;

float distance_to_edge(float2 local, float2 half_size, float radius) {
    return rounded_box(local, half_size, float4(radius, radius, radius, radius));
}

float4 main(pixel_input input) : SV_Target {
    float4 bounds = passing.bounds;
    float radius = passing.layer.x;
    float rim = passing.layer.y;
    float opacity = passing.layer.z;
    bool is_backdrop = passing.layer.w > 0.5f;

    float2 half_size = (bounds.zw - bounds.xy) * 0.5f;
    float2 local = input.pixel - (bounds.xy + bounds.zw) * 0.5f;
    float distance = distance_to_edge(local, half_size, radius);
    float mask = saturate(0.5f - distance);

    float2 uv = input.pixel * passing.mapping.xy + passing.mapping.zw;
    float lift = 1.0f;
    if (rim > 0.0f) {
        // The field's gradient by central differences: the edge's outward normal. Where the band
        // is wider than the corner radius it meets the box's diagonal, and turns there across about
        // a pixel.
        const float e = 0.5f;
        float2 gradient = float2(
            distance_to_edge(local + float2(e, 0.0f), half_size, radius)
                - distance_to_edge(local - float2(e, 0.0f), half_size, radius),
            distance_to_edge(local + float2(0.0f, e), half_size, radius)
                - distance_to_edge(local - float2(0.0f, e), half_size, radius)
        );
        float2 normal = gradient / max(length(gradient), 1e-4f);
        // One at the edge, zero a rim's width inside it, easing in.
        float t = saturate(1.0f + distance / rim);
        float bend = t * t;
        uv += normal * (bend * rim * rim_pull) * passing.mapping.xy;
        lift = 1.0f + rim_lift * bend;
    }

    float4 color = source.SampleLevel(linear_clamp, clamp(uv, passing.limit.xy, passing.limit.zw), 0.0f);
    if (is_backdrop) {
        // What the target held is what was on screen, whatever its alpha says: opaque where seen.
        // Premultiplied, so lifting rgb alone brightens without changing coverage.
        color = float4(color.rgb * lift, 1.0f);
    }
    // The layer's own mask is closed by now; what is left are its parents'.
    return color * (opacity * mask * mask_of(input.pixel));
}
