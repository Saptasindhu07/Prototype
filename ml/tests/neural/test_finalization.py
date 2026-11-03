"""Failed or duplicate workers must never package an unfinished training run."""
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from finalize_training import finalize


class FinalizationTests(unittest.TestCase):
    def test_failed_training_stops_before_model_or_test_evaluation(self):
        with TemporaryDirectory() as directory:
            run = Path(directory)
            (run / "config.json").write_text("{}")
            (run / "failure.json").write_text("{}")
            with self.assertRaisesRegex(RuntimeError, "Training failed"):
                finalize(run)
            self.assertEqual(json.loads((run / "finalization-status.json").read_text())["phase"], "failed")
            self.assertFalse((run / "finalization.lock").exists())
            self.assertFalse((run / "heldout-selection.json").exists())
            self.assertFalse((run / "ready-model.json").exists())

    def test_duplicate_worker_leaves_existing_worker_lock_untouched(self):
        with TemporaryDirectory() as directory:
            run = Path(directory)
            (run / "config.json").write_text("{}")
            (run / "finalization.lock").write_text("existing-worker")
            with self.assertRaises(FileExistsError):
                finalize(run)
            self.assertEqual((run / "finalization.lock").read_text(), "existing-worker")
            self.assertFalse((run / "finalization-status.json").exists())
