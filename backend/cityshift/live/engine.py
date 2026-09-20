from __future__ import annotations

import socket
import subprocess
from pathlib import Path

import sumolib
import traci

from cityshift.contracts import CityPack
from cityshift.live.contracts import (
    HAZARDS,
    BusRouteChange,
    DevelopmentChange,
    IncidentChange,
    Intervention,
    PopulationChange,
    RemoveDevelopmentChange,
    RoadChange,
    SessionConfig,
    TemperatureChange,
    temperature_response,
)
from cityshift.live.network import LiveNetwork
from cityshift.live.population import Population
from cityshift.live.recording import FrameStore
from cityshift.live.swarm import Swarm, SwarmEvent
from cityshift.live.transit import Transit
from cityshift.transport.sumo_env import binary
from cityshift.transport.sumo_xml import BusStopDef, write_additional, write_routes, write_sumocfg


class LiveEngine:
    def __init__(self, pack: CityPack, config: SessionConfig, root: Path, recording: FrameStore | None = None):
        self.pack = pack
        self.config = config
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.net = sumolib.net.readNet(pack.net_file)
        x0, y0, x1, y1 = self.net.getBoundary()
        self.origin = ((x0 + x1) / 2, (y0 + y1) / 2)
        self.recording = recording or FrameStore(self.root / "frames")
        self.time_s = 0
        self.temperature_c = config.temperature_c
        self.entities: list[dict] = []
        self.closed = False
        self.connection = None
        additional, routes, cfg = self.root / "stops.add.xml", self.root / "routes.xml", self.root / "session.sumocfg"
        stops = [BusStopDef(s.stop_id, f"{s.edge_id}_{s.lane_index}", s.start_pos, s.end_pos, s.name, 400) for s in pack.stops]
        write_additional(additional, stops)
        write_routes(routes, [], [], [])
        write_sumocfg(cfg, Path(pack.net_file), routes, [additional], config.horizon_s, config.seed, self.root / "tripinfo.xml")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.log = (self.root / "sumo.log").open("w")
        self.process = subprocess.Popen([
            binary("sumo"), "-c", str(cfg), "--remote-port", str(port),
            "--time-to-teleport", "-1", "--duration-log.statistics", "false",
        ], stdout=self.log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        try:
            self.connection = traci.connect(port, numRetries=240, waitBetweenRetries=0.25, proc=self.process)
            self.engine_version = self.connection.getVersion()[1]
            self.network = LiveNetwork(self.net, self.connection, self.origin)
            self.transit = Transit(self.network, pack, config, self.entities)
            self.swarm = Swarm(config.seed, self.root.name)
            self.population = Population(self.network, self.transit, pack, config, self.entities, self.swarm)
            self.population.add_initial()
            if self.recording.latest_s < 0:
                self.recording.append(0, [], self.counts(), self.temperature_c)
        except Exception:
            self.close()
            raise

    def apply(self, intervention: Intervention, command_id: str) -> dict:
        if isinstance(intervention, TemperatureChange):
            self.temperature_c = intervention.temperature_c
            self.population.change_temperature(self.temperature_c)
            return temperature_response(self.temperature_c).model_dump()
        if isinstance(intervention, RoadChange):
            result = self.network.apply(intervention, self.time_s)
            self.population.reconsider()
            return result
        if isinstance(intervention, BusRouteChange):
            result = self.transit.add(intervention, command_id, self.time_s)
            self.population.reconsider()
            return result
        if isinstance(intervention, PopulationChange):
            return self.population.add(intervention, command_id, self.time_s)
        if isinstance(intervention, IncidentChange):
            return self.declare_incident(intervention, command_id)
        if isinstance(intervention, DevelopmentChange):
            return self.population.add_development(intervention, command_id, self.time_s)
        if isinstance(intervention, RemoveDevelopmentChange):
            return self.population.remove_development(intervention.development_id, self.time_s)
        raise ValueError("unsupported live intervention")

    def declare_incident(self, change: IncidentChange, command_id: str) -> dict:
        x, y = self.net.convertLonLat2XY(change.lon, change.lat)
        edges = self.network.edges_within(x, y, change.radius_m)
        if not edges:
            raise ValueError("no streets lie inside that footprint; place the incident on the city")
        profile = HAZARDS[change.hazard]
        event = SwarmEvent(
            event_id=f"ev-{len(self.swarm.events) + 1}", command_id=command_id, hazard=change.hazard, label=change.label or profile.label,
            x=x, y=y, radius_m=float(change.radius_m), alarm_radius_m=change.alarm_radius_m, start_s=self.time_s,
            end_s=self.time_s + change.effective_duration_s, blocks=profile.blocks, edge_ids=tuple(edges),
        )
        self.network.apply_incident(event, self.time_s)
        self.swarm.post(event)
        self.population.respond(self.swarm.step(self.time_s, self.population.positions, self.population.reach), self.time_s)
        self.population.reconsider()
        return {"event_id": event.event_id, "edges": len(edges), "alarm_radius_m": event.alarm_radius_m, "ends_s": event.end_s, "witnesses": self.swarm.witnessed}

    def snapshot_developments(self) -> list[dict]:
        return self.population.snapshot_developments()

    def snapshot_incidents(self) -> list[dict]:
        return [
            {
                "event_id": ev.event_id, "command_id": ev.command_id, "hazard": ev.hazard, "label": ev.label,
                "x": round(ev.x - self.origin[0], 2), "z": round(ev.y - self.origin[1], 2), "radius_m": ev.radius_m,
                "alarm_radius_m": ev.alarm_radius_m, "start_s": ev.start_s, "end_s": ev.end_s, "blocks": list(ev.blocks),
                "edge_ids": list(ev.edge_ids)[:512], "active": ev.active(self.time_s),
            }
            for ev in self.swarm.events.values()
        ]

    def counts(self) -> dict[str, int]:
        return self.population.counts()

    def metrics(self) -> dict:
        return self.population.metrics() | {"rerouted": self.network.rerouted, "warnings": list(self.network.warnings)}

    def step(self, record: bool = True) -> None:
        if self.closed or self.connection is None:
            raise RuntimeError("session is closed")
        if self.time_s >= self.config.horizon_s:
            raise ValueError("simulation horizon reached")
        blocked = (self.network.closed_edges.copy(), self.network.blocked_walk.copy())
        self.network.expire(self.time_s)
        if blocked != (self.network.closed_edges, self.network.blocked_walk):
            self.population.reconsider()
        self.population.before_step(self.time_s)
        self.connection.simulationStep()
        self.time_s = int(self.connection.simulation.getTime())
        rows = self.population.observe(self.time_s)
        if record:
            self.recording.append(self.time_s, rows, self.counts(), self.temperature_c)

    def advance_to(self, target_s: int, record: bool = True) -> None:
        if not self.time_s <= target_s <= self.config.horizon_s:
            raise ValueError("advance must stay between current time and the horizon; past edits require a branch")
        while self.time_s < target_s:
            self.step(record)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            if self.connection is not None:
                self.connection.close(wait=False)
        finally:
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            self.log.close()
