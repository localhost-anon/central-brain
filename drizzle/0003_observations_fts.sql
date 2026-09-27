CREATE VIRTUAL TABLE observations_fts USING fts5(observation, content='observations', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, observation) VALUES (new.id, new.observation);
END;
--> statement-breakpoint
CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, observation) VALUES ('delete', old.id, old.observation);
END;
--> statement-breakpoint
CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, observation) VALUES ('delete', old.id, old.observation);
  INSERT INTO observations_fts(rowid, observation) VALUES (new.id, new.observation);
END;