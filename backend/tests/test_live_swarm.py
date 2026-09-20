from cityshift.live.swarm import FLAG_FRESH, FLAG_IN_ZONE, FLAG_RESPONDED, AgentMessage, Swarm, SwarmEvent


def event(t=0, radius=50.0, alarm=125.0, blocks=("passenger", "bus")):
    return SwarmEvent(event_id="ev-1", command_id="cmd-1", hazard="crash", label="Vehicle collision", x=0.0, y=0.0,
                      radius_m=radius, alarm_radius_m=alarm, start_s=t, end_s=t + 600, blocks=blocks, edge_ids=("e_BC",))


def line(n, spacing, start=0.0):
    return {f"p{i}": (start + i * spacing, 0.0) for i in range(n)}


def test_witnesses_inside_the_alarm_radius_receive_hop_zero_envelopes_and_nobody_else_does():
    swarm = Swarm(seed=7, session_id="live-test")
    swarm.post(event())
    deliveries = swarm.step(0, {"near": (60.0, 0.0), "edge": (124.0, 0.0), "far": (400.0, 0.0)})
    assert sorted(d.recipient for d in deliveries) == ["edge", "near"]
    assert all(isinstance(d, AgentMessage) and d.metadata["hop"] == 0 and d.sender is None and d.topic_id == "incident/ev-1" for d in deliveries)
    assert all(d.session_id == "live-test" and d.message["hazard"] == "crash" for d in deliveries)
    assert swarm.awareness_of("far") is None
    assert swarm.metrics()["witnessed"] == 2 and swarm.metrics()["messages"] == 2


def test_news_travels_agent_to_agent_with_increasing_hops_and_a_hop_budget():
    swarm = Swarm(seed=7, session_id="live-test", comm_radius_m=30.0, contact_probability=1.0, hop_budget=3, cooldown_s=0)
    swarm.post(event(radius=10.0, alarm=20.0))
    agents = line(12, 25.0)
    hops = {}
    for t in range(12):
        for d in swarm.step(t, agents):
            hops[d.recipient] = d.metadata["hop"]
    assert hops["p0"] == 0
    assert hops["p1"] == 1 and hops["p2"] == 2 and hops["p3"] == 3
    assert "p4" not in hops, "the hop budget must stop an infinite chain"
    assert all(isinstance(d.sender, str) for d in swarm.log if d.metadata["hop"] > 0)
    by_hop = swarm.metrics()["by_hop"]
    assert by_hop == {"0": 1, "1": 1, "2": 1, "3": 1}


def test_gossip_is_deterministic_probabilistic_and_bounded_per_step():
    agents = {f"a{i}": (float(i % 40) * 5.0, float(i // 40) * 5.0) for i in range(1600)}
    runs = []
    for _ in range(2):
        swarm = Swarm(seed=11, session_id="live-test", comm_radius_m=12.0, contact_probability=0.4, cooldown_s=2, max_broadcasts_per_step=50)
        swarm.post(event(radius=8.0, alarm=15.0))
        counts, broadcasts = [], []
        for t in range(12):
            counts.append(len(swarm.step(t, agents)))
            broadcasts.append(swarm.last_broadcasts)
        runs.append((counts, sorted(swarm.aware_ids())))
    assert runs[0] == runs[1]
    assert max(broadcasts) <= 50
    assert 0 < len(runs[0][1]) < 1600


def test_flags_and_awareness_end_with_the_event_but_the_log_survives():
    swarm = Swarm(seed=7, session_id="live-test")
    swarm.post(event(t=0, radius=50.0, alarm=125.0))
    swarm.step(0, {"near": (10.0, 0.0), "edge": (100.0, 0.0)})
    swarm.mark_responded("near")
    flags = swarm.flags("near", 0)
    assert flags & 7 == 1 and flags & FLAG_RESPONDED and flags & FLAG_IN_ZONE and flags & FLAG_FRESH
    assert swarm.flags("edge", 0) & FLAG_IN_ZONE == 0
    assert swarm.flags("near", 5) & FLAG_FRESH == 0
    swarm.step(700, {"near": (10.0, 0.0), "edge": (100.0, 0.0)})
    assert swarm.flags("near", 700) == 0
    assert not swarm.active_events(700)
    assert len(swarm.log) == 2
    assert swarm.metrics()["events"][0]["ended"] is True
