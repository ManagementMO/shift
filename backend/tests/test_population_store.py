from __future__ import annotations

import pytest
from test_population_world import definition

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
