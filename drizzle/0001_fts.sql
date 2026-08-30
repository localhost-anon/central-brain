CREATE VIRTUAL TABLE knowledge_fts USING fts5(statement, category, content='knowledge', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, statement, category) VALUES (new.id, new.statement, new.category);
END;
--> statement-breakpoint
CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, statement, category) VALUES ('delete', old.id, old.statement, old.category);
END;
--> statement-breakpoint
CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, statement, category) VALUES ('delete', old.id, old.statement, old.category);
  INSERT INTO knowledge_fts(rowid, statement, category) VALUES (new.id, new.statement, new.category);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE learnings_fts USING fts5(learning, "trigger", content='learnings', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts(rowid, learning, "trigger") VALUES (new.id, new.learning, new."trigger");
END;
--> statement-breakpoint
CREATE TRIGGER learnings_ad AFTER DELETE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, learning, "trigger") VALUES ('delete', old.id, old.learning, old."trigger");
END;
--> statement-breakpoint
CREATE TRIGGER learnings_au AFTER UPDATE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, learning, "trigger") VALUES ('delete', old.id, old.learning, old."trigger");
  INSERT INTO learnings_fts(rowid, learning, "trigger") VALUES (new.id, new.learning, new."trigger");
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE decisions_fts USING fts5(decision, reason, content='decisions', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, decision, reason) VALUES (new.id, new.decision, new.reason);
END;
--> statement-breakpoint
CREATE TRIGGER decisions_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reason) VALUES ('delete', old.id, old.decision, old.reason);
END;
--> statement-breakpoint
CREATE TRIGGER decisions_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reason) VALUES ('delete', old.id, old.decision, old.reason);
  INSERT INTO decisions_fts(rowid, decision, reason) VALUES (new.id, new.decision, new.reason);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE failures_fts USING fts5(error_message, context, content='failures', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER failures_ai AFTER INSERT ON failures BEGIN
  INSERT INTO failures_fts(rowid, error_message, context) VALUES (new.id, new.error_message, new.context);
END;
--> statement-breakpoint
CREATE TRIGGER failures_ad AFTER DELETE ON failures BEGIN
  INSERT INTO failures_fts(failures_fts, rowid, error_message, context) VALUES ('delete', old.id, old.error_message, old.context);
END;
--> statement-breakpoint
CREATE TRIGGER failures_au AFTER UPDATE ON failures BEGIN
  INSERT INTO failures_fts(failures_fts, rowid, error_message, context) VALUES ('delete', old.id, old.error_message, old.context);
  INSERT INTO failures_fts(rowid, error_message, context) VALUES (new.id, new.error_message, new.context);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE goals_fts USING fts5(title, objective, content='goals', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER goals_ai AFTER INSERT ON goals BEGIN
  INSERT INTO goals_fts(rowid, title, objective) VALUES (new.rowid, new.title, new.objective);
END;
--> statement-breakpoint
CREATE TRIGGER goals_ad AFTER DELETE ON goals BEGIN
  INSERT INTO goals_fts(goals_fts, rowid, title, objective) VALUES ('delete', old.rowid, old.title, old.objective);
END;
--> statement-breakpoint
CREATE TRIGGER goals_au AFTER UPDATE ON goals BEGIN
  INSERT INTO goals_fts(goals_fts, rowid, title, objective) VALUES ('delete', old.rowid, old.title, old.objective);
  INSERT INTO goals_fts(rowid, title, objective) VALUES (new.rowid, new.title, new.objective);
END;
