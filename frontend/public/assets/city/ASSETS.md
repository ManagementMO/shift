# Cityscape asset provenance

These are render-only assets. Roads, vehicle positions, travel times, queues and simulation outcomes still come from the city pack and recorded SUMO runs.

| Asset | Source and rights | Processing |
| --- | --- | --- |
| `toronto-massing.json` | City of Toronto, **3D Massing, 2025**, [dataset catalogue](https://open.toronto.ca/dataset/3d-massing/), Open Government Licence – Toronto | A downtown sample within approximately 1.55 km of CN Tower, reprojected from the supplied EPSG:3857 geodatabase into the pack's UTM 17N/world coordinates. Roof surfaces become simplified tiers at 0.4 m tolerance. 1,562 retained building records, 11,578 tiers, 3,754,534 bytes. |
| `afternoon-sky.hdr` | Poly Haven, [Kloofendal 48d Partly Cloudy Pure Sky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky), [CC0](https://polyhaven.com/license) | Original 1K HDR download, sampled as a 128px cube environment by Babylon. |
| `models/*.glb` | Original procedural artwork made for CITY//SHIFT by `scripts/build_landmarks.py` | Blender-generated, material-batched GLBs for CN Tower, Rogers Centre, Union Station and Scotiabank Arena. Approximately 1.36 MB combined, 23 material primitives. No third-party model or texture dependencies. |

The landmark models and façade treatments are **illustrative interpretations**, not architectural surveys. The massing reduction preserves major roof heights and setbacks but simplifies curved/sloping surfaces and omits some small features. Surrounding buildings use the pack's OSM footprints and procedural architecture. Public-space furniture is decorative; it is not an inventory of real installed street furniture.

The base world uses [OpenStreetMap](https://www.openstreetmap.org/copyright). On-screen attribution is retained. The generated massing asset includes its source, licence, coordinate-network fingerprint and geometry note. It is only enabled when its fingerprint matches the active Toronto pack. Missing or mismatched optional assets leave the procedural city available.

Source download for the massing conversion:

https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/387b2e3b-2a76-4199-8b3b-0b7d22e2ec10/resource/ad1164e1-cd93-4314-b73c-e9ebf87a1c74/download/3dmassingmultipatch_2025_wgs84.zip

Despite its filename, the inspected FileGDB layers report EPSG:3857. The conversion uses the layer coordinates in that CRS, then applies the active pack's projection and origin offsets. Never align this asset by changing simulation coordinates.

HDR download:

https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_puresky_1k.hdr

See `docs/TORONTO_CITYSCAPE.md` for runtime and rebuild instructions.
