"""Author a separate multi-view revision of the existing procedural specification."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / "heart-reference-retry"


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(name, data):
    (ROOT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pixel(x, y, z=0):
    # Source sheet front quadrant -> retained factory's virtual pixel coordinate system.
    return [round(560 + (x - 354) * 280 / 138, 3), round(700 + (y - 316.5) * 280 / 138, 3), z]


def world(p):
    return [(p[0] - 560) / 280, (700 - p[1]) / 280, p[2]]


def main():
    if (ROOT / "object-sculpt-spec.json").exists():
        raise FileExistsError("Authoring is initialization-only; existing spec/review history must not be overwritten")
    layout = read(BASE / "anatomy-layout.json")
    layout["depthScale"] = 1.0
    layout["source"] = "reference-sheet.png"
    layout["coordinateMapping"] = "+Z anterior; +X anatomical left; virtual pixels x=(px-560)/280, y=(700-py)/280. Source-sheet front: X=(sx-354)/138, Y=(316.5-sy)/138. Depth inferred from side silhouettes."
    layout["bodyStations"] = [
        [-2.18, .90, .001, .001, .22], [-2.12, .89, .24, .17, .23],
        [-1.96, .73, .52, .36, .21], [-1.66, .51, .86, .54, .16],
        [-1.26, .29, 1.13, .74, .10], [-.78, .17, 1.25, .90, .04],
        [-.25, .08, 1.24, 1.00, -.01], [.19, -.03, 1.08, .89, -.02],
        [.52, -.11, .79, .64, -.05], [.78, -.16, .36, .34, -.10],
        [.92, -.16, .001, .001, -.12]]
    layout["atria"] = [
        {"id": "right-atrium", "label": "右心房", "center": [-1.02, .04, -.16], "scale": [.37, .73, .60], "rotation": -.16},
        {"id": "left-atrium", "label": "左心房", "center": [.04, .18, -.71], "scale": [1.06, .79, .51], "rotation": .10},
        {"id": "right-auricle", "label": "右心耳", "center": [-.91, .47, .42], "scale": [.43, .53, .30], "rotation": -.45},
        {"id": "left-auricle", "label": "左心耳", "center": [.66, .60, .51], "scale": [.45, .32, .33], "rotation": .65}]
    paths = {
        "aortic-arch": ([(289,263,-.08),(280,190,-.03),(299,128,-.04),(326,96,-.13),(353,108,-.26),(379,149,-.49),(380,239,-.64)], [.20,.25,.26,.26,.25,.23,.19]),
        "brachiocephalic-branch": ([(316,96,-.11),(300,67,-.05),(289,31,.03)], [.12,.108,.10]),
        "left-carotid-branch": ([(346,97,-.20),(349,59,-.15),(350,18,-.04)], [.105,.103,.103]),
        "left-subclavian-branch": ([(370,108,-.32),(377,65,-.26),(385,33,-.16)], [.099,.09,.089]),
        "pulmonary-trunk": ([(316,278,.44),(334,210,.65),(371,161,.61),(417,141,.36),(470,141,.22)], [.23,.25,.24,.19,.16]),
        "right-pulmonary-branch": ([(368,164,.08),(330,160,-.53),(267,151,-.58),(224,160,-.55)], [.16,.17,.16,.15]),
        "superior-vena-cava": ([(211,268,-.27),(221,207,-.26),(222,132,-.25),(218,86,-.20)], [.22,.215,.216,.219]),
        "inferior-vena-cava": ([(219,350,-.36),(229,430,-.39),(243,503,-.40),(246,567,-.36)], [.20,.215,.215,.21]),
        "right-superior-pulmonary-vein": ([(326,247,-.86),(226,235,-.83),(164,216,-.70)], [.102,.102,.095]),
        "right-inferior-pulmonary-vein": ([(326,277,-.88),(226,263,-.85),(159,254,-.73)], [.10,.099,.094]),
        "left-superior-pulmonary-vein": ([(376,232,-.84),(449,212,-.83),(482,190,-.68)], [.102,.10,.095]),
        "left-inferior-pulmonary-vein": ([(373,277,-.88),(454,250,-.85),(505,223,-.71)], [.101,.10,.092])}
    for vessel in layout["greatVessels"]:
        points, radii = paths[vessel["id"]]
        vessel["points"] = [pixel(*p) for p in points]
        vessel["radii"] = radii
        vessel["label"] = vessel["label"].replace("（遮挡部分推断）", "")
    xy_paths = {
        "anterior": [(393,267),(419,326),(414,389),(407,450),(410,507),(443,576)],
        "right": [(274,255),(248,307),(233,362),(231,421),(269,480),(330,525),(442,587)],
        "circumflex": [(414,301),(456,313),(494,346),(520,408),(531,457)],
        "posterior": [(361,367),(348,420),(363,470),(404,543),(453,586)],
        "posteriorAV": [(194,341),(236,352),(286,362),(343,368),(407,392),(471,430)]}
    layout["coronaryPathsPixels"] = {name: [pixel(x,y)[:2] for x,y in points] for name,points in xy_paths.items()}
    layout["note"] = "Front coordinates traced visually from user sheet. Rear atrial volume, sagittal tilt and vessel depth constrained qualitatively by left/rear/right illustrations. Fine vessels and occluded contacts remain approximate."
    write("anatomy-layout.json", layout)

    spec = read(BASE / "object-sculpt-spec.json")
    spec["targetName"], spec["targetId"] = "Heart Four View Retry", ROOT.name
    refs = read(ROOT / "references.json")
    spec["sourceImage"], spec["referenceSet"] = refs["views"][0]["path"], refs
    spec["referenceCamera"].update({"solved": False, "aspect": .8, "orientation": {"yaw":0,"pitch":0,"roll":0}, "positionHint":[0,0,9], "note":"Nominal orthographic anterior view; not calibrated"})
    spec["reviewHistory"], spec["tier1Results"], spec["visualEvidence"] = [], [], []
    spec["sculptPipeline"].update({"currentPass":"blockout", "completedPasses":[], "lastCompletedPass":None, "blockedReason":"", "nextRequiredEvidence":[]})
    # This is a revision of the authored baseline. Existing macro/structure code is reused,
    # while all new-reference gates are reset. Old approvals are not transferred.
    for p in spec["buildPasses"]:
        p["goal"] = "Four-view revision: " + p["goal"]
    spec["qualityContract"]["definitionOfDone"][0] = "One coherent closed procedural model matches all four supplied views; anatomy-side camera convention is explicit."
    spec["qualityContract"]["definitionOfDone"][3] = "All four critical matched views and a three-quarter render are inspected; previous single-image approvals do not apply."
    spec["qualityContract"]["featureGroups"][2]["qualityCriteria"] = ["Posterior left atrial mass covers upper rear wall; right atrium is dominant in right view.", "Anterior auricles are distinct tapered lobulated flaps, not symmetric balls."]
    spec["localSpecSearch"] = read(ROOT / "assessment.json")["localSpecSearch"]
    spec["preSpecAssessment"]["sourceImage"] = spec["sourceImage"]
    spec["preSpecAssessment"]["referenceSet"] = refs
    spec["assumptions"] = ["Illustrations are uncalibrated observations of one intended heart.", "Depth, hidden contacts and capillary correspondence are approximate.", "Existing tissue texture maps are reused from the previous single-image experiment with provenance retained."]
    for c in spec["componentTree"]:
        if c["id"] == "ventricular-body":
            c["geometryDescriptor"]["taperedSweep"]["stations"] = [{"position":[x,y,z],"rx":rx,"rz":rz} for y,x,rx,rz,z in layout["bodyStations"]]
        for a in layout["atria"]:
            if c["id"] == a["id"]:
                c["transform"] = {"position":a["center"],"scale":a["scale"],"rotation":[0,0,a["rotation"]]}
        c["confidence"] = min(c.get("confidence", .75), .8)
        c["topologyRationale"] = c.get("topologyRationale", "").replace("single reference", "four-view reference set")
    spec.setdefault("extensions", {})["multiViewRevision"] = {"baselineSpec":str(BASE / "object-sculpt-spec.json"), "baselineApprovalsTransferred":False, "layout":layout, "implementation":"Hand-authored TypeScript revision of existing factory; no neural mesh extraction", "criticalViews":["front","left","rear","right"]}
    write("object-sculpt-spec.json", spec)
    write("reference-suitability.json", {"verdict":"conditional", "allViewsAdmitted":True, "evidence":"reference-set-intake.json", "limitations":spec["assumptions"]})
    write("projection-route.json", {"route":"reused-reference-derived-tissue", "baseline":str(BASE / "public" / "textures"), "reason":"No solved per-region cameras; avoid baking independent illustrated views onto inconsistent surfaces", "limitation":"Fine texture pattern remains approximate and inherited, not extracted from new source"})


if __name__ == "__main__":
    main()
