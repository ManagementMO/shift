FAILED_EPOCHS = set(range(3, 13))


def large_actor_packet(resident, epoch):
    task_ids = [f"task-{resident}-{index}" for index in range(32)]
    return {
        "run_id": "native-window-proof", "resident_id": resident, "epoch": epoch, "t": epoch * 30,
        "world_version": epoch, "profile": {"resident_id": resident, "persona": "Explicit local projection fixture."},
        "state": {"resident_id": resident, "role": "courier", "anchor_id": "fixture-home",
                  "current_task_id": task_ids[31], "commitments": [task_ids[30]], "needs": {"rest": 0.2}},
        "memories": [{"event_id": f"memory-{resident}-{index}", "t": max(0, epoch * 30 - 64 + index),
                      "kind": "outcome", "text": f"window-private[{resident}] memory {index}: " + "m" * 330,
                      "related_residents": []} for index in range(64)],
        "messages": [{"message_id": f"message-{resident}-{index}", "sender_id": "known-contact",
                      "recipient_id": resident, "sent_s": 0, "delivered_s": 0,
                      "text": f"window-private[{resident}] message {index}: " + "v" * 120}
                     for index in range(24)],
        "tasks": [{"task_id": task_ids[index], "kind": "delivery", "status": "ready",
                   "requester_id": resident if index == 28 else "known-contact", "provider_id": None,
                   "assignee_id": resident if index in (30, 31) else None,
                   "service_anchor_id": "fixture-shop", "destination_anchor_id": "fixture-home",
                   "required_capacity": 1, "created_s": 0, "deadline_s": 3600, "ready_s": 0,
                   "completed_s": None, "failure_reason": None, "declined_by": [], "version": epoch,
                   "cause_id": f"fixture-request-{index}"} for index in range(32)],
        "contacts": ["known-contact"], "available_classes": ["pedestrian", "bicycle"],
        "trip_options": [{"target_id": f"fixture-anchor-{index}", "travel_class": "bicycle", "reachable": True,
                          "duration_s": 20 + index, "distance_m": 100 + index} for index in range(12)],
    }
