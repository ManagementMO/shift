"""Write SUMO input files (additionals, routes, sumocfg) from typed Python structures."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import quoteattr as q


@dataclass
class BusStopDef:
    stop_id: str
    lane: str
    start_pos: float
    end_pos: float
    name: str = ""
    person_capacity: int = 80


@dataclass
class BusTrip:
    vehicle_id: str
    edges: list[str]
    stops: list[tuple]  # (busStop id, min dwell seconds[, until seconds])
    depart_s: int
    capacity: int = 60
    line: str = ""
    vtype: str = "shuttle_bus"


@dataclass
class PersonTrip:
    person_id: str
    origin_edge: str
    stop_id: str | None  # board here; None => walk only
    alight_stop_id: str | None
    dest_edge: str
    depart_s: int
    lines: str = "ANY"
    walk_only: bool = False
    arrival_pos: float | None = None


@dataclass
class CarTrip:
    vehicle_id: str
    from_edge: str
    to_edge: str
    depart_s: int


@dataclass
class EdgeClosure:
    closure_id: str
    edge_ids: list[str]
    start_s: int
    end_s: int
    modes: list[str] = field(default_factory=lambda: ["passenger", "bus"])


VTYPES = """
    <vType id="shuttle_bus" vClass="bus" length="12.0" width="2.55" height="3.2" maxSpeed="20" accel="1.2" decel="4.0" personCapacity="{cap}" guiShape="bus" color="0,200,255"/>
    <vType id="car" vClass="passenger" length="4.5" width="1.8" maxSpeed="30" accel="2.6" decel="4.5" guiShape="passenger" color="220,220,200"/>
    <vType id="ped" vClass="pedestrian" width="0.6" length="0.4" maxSpeed="1.4" guiShape="pedestrian"/>
"""


def write_additional(path: Path, stops: list[BusStopDef], closures: list[EdgeClosure] | None = None) -> None:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<additional>"]
    for s in stops:
        lines.append(
            f'    <busStop id={q(s.stop_id)} lane={q(s.lane)} startPos="{s.start_pos:.2f}" endPos="{s.end_pos:.2f}" personCapacity="{s.person_capacity}"'
            f' name={q(s.name or s.stop_id)} friendlyPos="true"/>'
        )
    for c in closures or []:
        # Rerouter closingReroute closes an edge for the given vClasses during the interval.
        # Vehicles that already hold a route through the edge are rerouted when they reach the rerouter edge.
        edges = " ".join(c.edge_ids)
        lines.append(f'    <rerouter id={q(c.closure_id)} edges={q(edges)} vTypes="car shuttle_bus">')
        lines.append(f'        <interval begin="{c.start_s}" end="{c.end_s}">')
        for e in c.edge_ids:
            lines.append(f'            <closingReroute id={q(e)} disallow={q(" ".join(c.modes))}/>')
        lines.append("        </interval>")
        lines.append("    </rerouter>")
    lines.append("</additional>")
    path.write_text("\n".join(lines) + "\n")


def write_routes(
    path: Path,
    buses: list[BusTrip],
    persons: list[PersonTrip],
    cars: list[CarTrip],
    bus_capacity: int = 60,
) -> None:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<routes>", VTYPES.format(cap=bus_capacity)]
    # SUMO requires departures sorted by time when route-steps checking is on; we sort defensively.
    items: list[tuple[int, int, str]] = []
    for b in buses:
        stop_xml = ""
        for st in b.stops:
            sid, dur = st[0], st[1]
            until = f' until="{st[2]}"' if len(st) > 2 and st[2] is not None else ""
            stop_xml += f'\n        <stop busStop={q(sid)} duration="{dur}"{until}/>'
        items.append(
            (
                b.depart_s,
                0,
                (
                    f'    <vehicle id={q(b.vehicle_id)} type={q(b.vtype)} depart="{b.depart_s}" line={q(b.line or b.vehicle_id)} departPos="0">\n'
                    f'        <route edges={q(" ".join(b.edges))}/>{stop_xml}\n    </vehicle>'
                ),
            )
        )
    for c in cars:
        items.append(
            (
                c.depart_s,
                1,
                f'    <trip id={q(c.vehicle_id)} type="car" depart="{c.depart_s}" from={q(c.from_edge)} to={q(c.to_edge)}/>',
            )
        )
    for p in persons:
        if p.walk_only or p.stop_id is None or p.alight_stop_id is None:
            plan = f'\n        <walk from={q(p.origin_edge)} to={q(p.dest_edge)}/>'
        else:
            plan = (
                f'\n        <walk from={q(p.origin_edge)} busStop={q(p.stop_id)}/>'
                f'\n        <ride busStop={q(p.alight_stop_id)} lines={q(p.lines)}/>'
                f'\n        <walk to={q(p.dest_edge)}/>'
            )
        items.append(
            (
                p.depart_s,
                2,
                f'    <person id={q(p.person_id)} type="ped" depart="{p.depart_s}">{plan}\n    </person>',
            )
        )
    items.sort(key=lambda x: (x[0], x[1]))
    lines.extend(x[2] for x in items)
    lines.append("</routes>")
    path.write_text("\n".join(lines) + "\n")


def write_sumocfg(
    path: Path,
    net_file: Path,
    route_file: Path,
    additional_files: list[Path],
    end_s: int,
    seed: int,
    tripinfo: Path,
    step_length: float = 1.0,
) -> None:
    add = ",".join(str(a) for a in additional_files)
    path.write_text(
        f"""<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <input>
        <net-file value="{net_file}"/>
        <route-files value="{route_file}"/>
        <additional-files value="{add}"/>
    </input>
    <time>
        <begin value="0"/>
        <end value="{end_s}"/>
        <step-length value="{step_length}"/>
    </time>
    <processing>
        <time-to-teleport value="300"/>
        <ignore-route-errors value="true"/>
        <pedestrian.model value="striping"/>
    </processing>
    <random_number>
        <seed value="{seed}"/>
    </random_number>
    <output>
        <tripinfo-output value="{tripinfo}"/>
        <tripinfo-output.write-unfinished value="true"/>
        <vehroute-output value="{Path(tripinfo).with_name('vehroutes.xml')}"/>
        <vehroute-output.write-unfinished value="true"/>
        <vehroute-output.exit-times value="true"/>
    </output>
    <report>
        <no-step-log value="true"/>
        <no-warnings value="false"/>
        <duration-log.statistics value="true"/>
    </report>
</configuration>
"""
    )
