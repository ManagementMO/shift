from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import mongomock
import pytest
from test_population_world import definition

from cityshift.mongo_store import MongoStore
from cityshift.store import Store


def test_population_store_is_immutable_and_round_trips(tmp_path):
    store = Store(tmp_path)
    population = definition()
    store.put_population(population)
    assert store.get_population(population.population_id) == population
    store.put_population(population)
    assert store.list_populations() == [population]
    changed = population.model_copy(deep=True)
    changed.profiles[0].name = "Different profile"
    with pytest.raises(ValueError, match="immutable"):
        store.put_population(changed)
    assert store.get_population(population.population_id) == population


def test_population_paths_cannot_escape_the_store(tmp_path):
    store = Store(tmp_path)
    population = definition()
    population.population_id = "../escaped"
    with pytest.raises(ValueError, match="identifier"):
        store.put_population(population)
    with pytest.raises(ValueError, match="identifier"):
        store.get_population("../escaped")


def test_mongo_population_round_trips_and_rejects_changed_identity():
    client = mongomock.MongoClient()
    store = MongoStore(client["population_fixture"])
    population = definition()
    store.put_population(population)
    store.put_population(population)
    assert store.get_population(population.population_id) == population
    assert store.list_populations() == [population]
    changed = population.model_copy(deep=True)
    changed.profiles[0].name = "Changed resident"
    with pytest.raises(ValueError, match="immutable"):
        store.put_population(changed)
    assert store.get_population(population.population_id) == population
    store.close()


def test_concurrent_mongo_population_writers_cannot_replace_a_frozen_definition(monkeypatch):
    client = mongomock.MongoClient()
    database = client["population_fixture"]
    population = definition()
    barrier = Barrier(2)
    replace = database.populations.replace_one

    def simultaneous_replace(*args, **kwargs):
        barrier.wait(timeout=5)
        return replace(*args, **kwargs)

    monkeypatch.setattr(database.populations, "replace_one", simultaneous_replace)

    def insert(index):
        candidate = population.model_copy(deep=True)
        candidate.profiles[0].name = f"Candidate {index}"
        try:
            MongoStore(database).put_population(candidate)
            return candidate
        except ValueError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        winners = [value for value in pool.map(insert, range(2)) if value is not None]
    assert len(winners) == 1
    assert MongoStore(database).get_population(population.population_id) == winners[0]
    assert database.populations.count_documents({}) == 1
    client.close()
