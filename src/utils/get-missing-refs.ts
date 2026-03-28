import type {Dataset} from "./types.ts";

interface MissingRefs {
    nodes: Set<number>;
    ways: Set<number>;
    relations: Set<number>;
}

export function getMissingRefs(dataset: Dataset): MissingRefs {
    const nodes = new Set<number>();
    const ways = new Set<number>();
    const relations = new Set<number>();

    for (const way of dataset.ways.values())
        for (const id of way.nodes)
            if (!dataset.nodes.has(id)) nodes.add(id);

    for (const rel of dataset.relations.values())
        for (const m of rel.members) {
            if (m.type === "node" && !dataset.nodes.has(m.ref)) nodes.add(m.ref);
            else if (m.type === "way" && !dataset.ways.has(m.ref)) ways.add(m.ref);
            else if (m.type === "relation" && !dataset.relations.has(m.ref)) relations.add(m.ref);
        }

    return {nodes, ways, relations};
}