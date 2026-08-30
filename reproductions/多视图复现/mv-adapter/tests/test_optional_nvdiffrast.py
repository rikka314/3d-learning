import importlib.util


has_nvdiffrast = importlib.util.find_spec("nvdiffrast") is not None

from mvadapter.utils.mesh_utils import get_orthogonal_camera


camera = get_orthogonal_camera(
    elevation_deg=[0.0],
    distance=[1.8],
    azimuth_deg=[0.0],
    left=-0.55,
    right=0.55,
    bottom=-0.55,
    top=0.55,
    device="cpu",
)
if camera.c2w.shape != (1, 4, 4):
    raise AssertionError(f"Unexpected camera matrix shape: {camera.c2w.shape}")

import mvadapter.utils.mesh_utils as mesh_utils


if has_nvdiffrast:
    mesh_utils.NVDiffRastContextWrapper
    print("geometry_dependency_present=ok")
else:
    try:
        mesh_utils.NVDiffRastContextWrapper
    except RuntimeError as exc:
        if "nvdiffrast is required" not in str(exc):
            raise AssertionError(f"Unexpected optional dependency error: {exc}") from exc
    else:
        raise AssertionError("geometry import unexpectedly succeeded without nvdiffrast")
    print("geometry_optional_dependency_error=ok")

print("camera_import=ok")
