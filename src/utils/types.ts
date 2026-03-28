
export interface OsmNode {
    type: "node";
    id: number; version: number; timestamp: string;
    uid: number; user: string; changeset: number;
    lat: number; lon: number;
    tags: Record<string, string>;
}

export interface OsmWay {
    type: "way";
    id: number; version: number; timestamp: string;
    uid: number; user: string; changeset: number;
    nodes: number[];
    tags: Record<string, string>;
}

export interface OsmRelation {
    type: "relation";
    id: number; version: number; timestamp: string;
    uid: number; user: string; changeset: number;
    members: { type: "node" | "way" | "relation"; ref: number; role: string }[];
    tags: Record<string, string>;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface Dataset {
    nodes:     Map<number, OsmNode>;
    ways:      Map<number, OsmWay>;
    relations: Map<number, OsmRelation>;
}

export interface ReplicationState {
    sequenceNumber: number;
    timestamp: string;
}

export interface StateFile {
    sequenceNumber_minute?: number;
    sequenceNumber_hour?:   number;
    timestamp?: string;
}

export type StateKey = "sequenceNumber_minute" | "sequenceNumber_hour";