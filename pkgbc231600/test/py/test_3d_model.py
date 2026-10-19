"""Visual wall extraction keeps voids and door gaps; it never supplies routing edges."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
try:
    spec = importlib.util.spec_from_file_location('grainger_model_builder', ROOT / 'tools/build_3d_model.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
except ModuleNotFoundError:
    builder = None


@unittest.skipIf(builder is None, 'Pillow is required to test the optional model-generation tool')
class WallGeometryTests(unittest.TestCase):
    def test_enclosed_wall_ring_retains_empty_room_as_hole(self):
        cells = {(x, y) for x in range(12) for y in range(10) if x in (0, 11) or y in (0, 9)}
        walls = builder.contours(cells)
        self.assertEqual(len(walls), 1)
        self.assertEqual(len(walls[0]['holes']), 1)
        interior = (12, 10)
        self.assertTrue(builder.inside(interior, walls[0]['outline']))
        self.assertTrue(builder.inside(interior, walls[0]['holes'][0]))

    def test_open_door_is_not_closed_by_wall_tracing(self):
        cells = {(x, y) for x in range(12) for y in range(10) if x in (0, 11) or y in (0, 9)}
        cells.difference_update({(5, 9), (6, 9)})
        walls = builder.contours(cells)
        doorway = (11, 19)
        for wall in walls:
            filled = builder.inside(doorway, wall['outline']) and not any(builder.inside(doorway, hole) for hole in wall['holes'])
            self.assertFalse(filled, 'tracing filled the open doorway')

    def test_packaged_model_has_three_finite_nonempty_floor_meshes_and_correct_voids(self):
        model = json.loads((ROOT / 'pkgbc231600/ui/react/src/assets/grainger-3d.json').read_text())
        self.assertEqual([floor['level'] for floor in model['floors']], [1, 2, 3])
        for floor in model['floors']:
            self.assertGreater(len(floor['walls']), 0)
            for wall in floor['walls']:
                self.assertGreaterEqual(len(wall['outline']), 3)
                for x, y in wall['outline']:
                    self.assertTrue(0 <= x <= model['imageWidth'])
                    self.assertTrue(0 <= y <= model['imageHeight'])
        for floor in model['floors'][1:]:
            self.assertTrue(any(builder.inside((512, 700), opening) for opening in floor['openings']))
