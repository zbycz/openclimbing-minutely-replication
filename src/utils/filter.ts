/**
 * Returns true if the element is a "climbing" element that belongs
 * in this filtered dataset (regardless of whether it's already present).
 *
 *     osmium tags-filter \
 *         planet-260316.osm.pbf \
 *         'nwr/climbing*' \
 *         nwr/sport=climbing \
 *         nwr/sport=via_ferrata \
 *         nwr/highway=via_ferrata \
 *         nwr/route=via_ferrata \
 *         nwr/via_ferrata_scale \
 *         --overwrite \
 *         --progress \
 *         -o filtered.osm.pbf
 */
export function isClimbing(tags: Record<string, string>): boolean {
    if (!tags) return false;
    return (
        tags["sport"] === "climbing" ||
        tags["sport"] === "via_ferrata" ||
        tags["highway"] === "via_ferrata" ||
        tags["route"] === "via_ferrata" ||
        "via_ferrata_scale" in tags ||
        Object.keys(tags).some(k => k.startsWith("climbing"))
    );
}
