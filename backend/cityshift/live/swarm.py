"""Agent-to-agent news propagation inside the live city.

Envelopes carry the same fields as openJiuwen's ``MessageEnvelope`` (message_id, message, sender, recipient,
topic_id, session_id, metadata) so a record can be handed to an openJiuwen team runtime unchanged. Delivery here is a
deterministic proximity gossip router that runs inside the SUMO step: travelers who see an incident publish it on the
incident topic, and informed travelers pass it to neighbors within earshot, one hop per simulated second.
"""

from __future__ import annotations

import random
from collections import Counter, defaultdict
from dataclasses import dataclass, field

FLAG_AWARE_MASK = 0b111
FLAG_RESPONDED = 1 << 3
FLAG_IN_ZONE = 1 << 4
FLAG_TRAPPED = 1 << 5
FLAG_FRESH = 1 << 6
FRESH_S = 2
LOG_LIMIT = 20000


@dataclass(frozen=True)
class AgentMessage:
    message_id: str
    message: dict
    sender: str | None
    recipient: str | None
    topic_id: str | None
    session_id: str | None
    metadata: dict = field(default_factory=dict)

    def to_envelope(self):
        from openjiuwen.core.multi_agent.team_runtime.envelope import MessageEnvelope

        return MessageEnvelope(self.message_id, self.message, self.sender, self.recipient, self.topic_id, self.session_id, dict(self.metadata))

    def summary(self) -> str:
        hop = self.metadata.get("hop", 0)
        if hop == 0:
            return f"{self.recipient} witnessed {self.message['label'].lower()}"
        return f"{self.recipient} heard about {self.message['label'].lower()} from {self.sender} (hop {hop})"


@dataclass(frozen=True)
class SwarmEvent:
    event_id: str
    command_id: str
    hazard: str
    label: str
    x: float
    y: float
    radius_m: float
    alarm_radius_m: float
    start_s: int
    end_s: int
    blocks: tuple[str, ...]
    edge_ids: tuple[str, ...]

    def active(self, t: int) -> bool:
        return self.start_s <= t < self.end_s

    def payload(self) -> dict:
        return {"event_id": self.event_id, "hazard": self.hazard, "label": self.label, "radius_m": self.radius_m, "blocks": list(self.blocks), "ends_s": self.end_s}


@dataclass
class Awareness:
    event_id: str
    hop: int
    t: int
    source: str | None
    responded: bool = False
    trapped: bool = False
    last_broadcast_s: int = -1


class Swarm:
    def __init__(self, seed: int, session_id: str, comm_radius_m: float = 25.0, contact_probability: float = 0.35,
                 hop_budget: int = 6, cooldown_s: int = 4, max_broadcasts_per_step: int = 600):
        self.rng = random.Random((seed << 8) ^ 0x5A17)
        self.session_id = session_id
        self.comm_radius_m = comm_radius_m
        self.contact_probability = contact_probability
        self.hop_budget = hop_budget
        self.cooldown_s = cooldown_s
        self.max_broadcasts_per_step = max_broadcasts_per_step
        self.events: dict[str, SwarmEvent] = {}
        self.awareness: dict[str, dict[str, Awareness]] = {}
        self.log: list[AgentMessage] = []
        self.messages = 0
        self.witnessed = 0
        self.by_hop: Counter[int] = Counter()
        self.in_zone: set[str] = set()
        self.now = -1
        self.last_broadcasts = 0
        self.responses = 0

    def post(self, event: SwarmEvent) -> None:
        self.events[event.event_id] = event

    def active_events(self, t: int) -> list[SwarmEvent]:
        return [ev for ev in self.events.values() if ev.active(t)]

    def knows(self, agent: str, event_id: str) -> bool:
        return event_id in self.awareness.get(agent, {})

    def awareness_of(self, agent: str, t: int | None = None) -> Awareness | None:
        known = self.awareness.get(agent)
        if not known:
            return None
        candidates = [aw for aw in known.values() if t is None or self.events[aw.event_id].active(t)]
        return min(candidates, key=lambda aw: (aw.hop, -aw.t)) if candidates else None

    def aware_ids(self) -> list[str]:
        return [agent for agent, known in self.awareness.items() if known]

    def mark_responded(self, agent: str, trapped: bool = False) -> None:
        for aw in self.awareness.get(agent, {}).values():
            if not aw.responded:
                self.responses += 1
            aw.responded = True
            aw.trapped = trapped

    def step(self, t: int, positions: dict[str, tuple[float, float]], reach: dict[str, float] | None = None) -> list[AgentMessage]:
        """Deliver witness messages for every active event, then let informed agents tell neighbours within their reach."""
        self.now = t
        self.in_zone = set()
        self.last_broadcasts = 0
        active = self.active_events(t)
        if not active:
            return []
        deliveries: list[AgentMessage] = []
        for ev in active:
            r2, a2 = ev.radius_m ** 2, ev.alarm_radius_m ** 2
            for agent, (x, y) in positions.items():
                d2 = (x - ev.x) ** 2 + (y - ev.y) ** 2
                if d2 <= r2:
                    self.in_zone.add(agent)
                if d2 <= a2 and not self.knows(agent, ev.event_id):
                    deliveries.append(self._deliver(ev, agent, 0, None, t))
        reach = reach or {}
        cell = max(self.comm_radius_m, *reach.values()) if reach else self.comm_radius_m
        grid: dict[tuple[int, int], list[str]] = defaultdict(list)
        for agent, (x, y) in positions.items():
            grid[int(x // cell), int(y // cell)].append(agent)
        active_ids = {ev.event_id for ev in active}
        broadcasters = [
            (agent, aw) for agent, known in self.awareness.items() if agent in positions
            for aw in known.values()
            if aw.event_id in active_ids and aw.hop < self.hop_budget and aw.t < t and t - aw.last_broadcast_s >= max(1, self.cooldown_s)
        ]
        if len(broadcasters) > self.max_broadcasts_per_step:
            broadcasters = self.rng.sample(broadcasters, self.max_broadcasts_per_step)
        for agent, aw in broadcasters:
            aw.last_broadcast_s = t
            self.last_broadcasts += 1
            x, y = positions[agent]
            cx, cy = int(x // cell), int(y // cell)
            radius = reach.get(agent, self.comm_radius_m)
            limit2 = radius * radius
            event = self.events[aw.event_id]
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other in grid.get((cx + dx, cy + dy), ()):
                        if other == agent or self.knows(other, aw.event_id):
                            continue
                        ox, oy = positions[other]
                        if (ox - x) ** 2 + (oy - y) ** 2 <= limit2 and self.rng.random() < self.contact_probability:
                            deliveries.append(self._deliver(event, other, aw.hop + 1, agent, t))
        return deliveries

    def _deliver(self, event: SwarmEvent, agent: str, hop: int, sender: str | None, t: int) -> AgentMessage:
        self.awareness.setdefault(agent, {})[event.event_id] = Awareness(event.event_id, hop, t, sender)
        self.messages += 1
        self.by_hop[hop] += 1
        if hop == 0:
            self.witnessed += 1
        message = AgentMessage(
            message_id=f"{event.event_id}:{self.messages}", message=event.payload(), sender=sender, recipient=agent,
            topic_id=f"incident/{event.event_id}", session_id=self.session_id, metadata={"hop": hop, "t": t, "event_id": event.event_id},
        )
        self.log.append(message)
        if len(self.log) > LOG_LIMIT:
            del self.log[: len(self.log) - LOG_LIMIT]
        return message

    def flags(self, agent: str, t: int) -> int:
        aw = self.awareness_of(agent, t)
        if aw is None:
            return 0
        value = min(7, aw.hop + 1)
        if aw.responded:
            value |= FLAG_RESPONDED
        if aw.trapped:
            value |= FLAG_TRAPPED
        if agent in self.in_zone:
            value |= FLAG_IN_ZONE
        if t - aw.t < FRESH_S:
            value |= FLAG_FRESH
        return value

    def metrics(self) -> dict:
        active_ids = {ev.event_id for ev in self.active_events(self.now)}
        aware_total = sum(1 for known in self.awareness.values() if any(aw.event_id in active_ids for aw in known.values()))
        events = []
        for ev in self.events.values():
            aware = sum(1 for known in self.awareness.values() if ev.event_id in known)
            events.append({**ev.payload(), "command_id": ev.command_id, "x": ev.x, "y": ev.y, "alarm_radius_m": ev.alarm_radius_m, "start_s": ev.start_s, "ended": ev.end_s <= self.now, "aware": aware, "edges": len(ev.edge_ids)})
        return {
            "events": events, "witnessed": self.witnessed, "messages": self.messages, "aware_total": aware_total,
            "by_hop": {str(hop): n for hop, n in sorted(self.by_hop.items())}, "responded": self.responses,
            "in_zone": len(self.in_zone), "broadcasts_last_step": self.last_broadcasts,
            "feed": [{"t": m.metadata["t"], "hop": m.metadata["hop"], "text": m.summary()} for m in self.log[-12:]],
        }
