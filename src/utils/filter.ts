/**
 * Returns true if the element is a "climbing" element that belongs
 * in this filtered dataset (regardless of whether it's already present).
 *
 *     osmium tags-filter \
 *         planet-260316.osm.pbf \
 *         'nwr/climbing*' \
 *         nwr/sport=climbing \
 *         nwr/sport=via_ferrata \
 *         --overwrite \
 *         --progress \
 *         -o filtered.osm.pbf
 */
export function isClimbing(tags: Record<string, string>): boolean {
    if (!tags || Object.keys(tags).length === 0) return false;
    return (
        tags["sport"] === "climbing" ||
        tags["sport"] === "via_ferrata" ||
        tags["leisure"] === "climbing" ||
        "climbing" in tags ||
        Object.keys(tags).some(k => k.startsWith("climbing"))
    );
}