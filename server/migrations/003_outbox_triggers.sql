CREATE FUNCTION publish_item_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('opsdesk.skip_outbox', true) = 'on' THEN
    RETURN NULL;
  END IF;

  INSERT INTO outbox_jobs (type, payload, dedupe_key)
  VALUES ('item_event', jsonb_build_object('eventId', NEW.id), 'item_event:' || NEW.id)
  ON CONFLICT (dedupe_key) DO NOTHING;

  PERFORM pg_notify('item_events', jsonb_build_object(
    'eventId', NEW.id,
    'itemId', NEW.item_id,
    'teamId', (SELECT team_id FROM work_items WHERE id = NEW.item_id),
    'type', NEW.type,
    'actorId', NEW.actor_id
  )::text);

  RETURN NULL;
END
$$;

CREATE TRIGGER work_item_events_publish
  AFTER INSERT ON work_item_events
  FOR EACH ROW EXECUTE FUNCTION publish_item_event();

CREATE FUNCTION publish_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('opsdesk.skip_outbox', true) = 'on' THEN
    RETURN NULL;
  END IF;

  PERFORM pg_notify('user_notifications', jsonb_build_object(
    'userId', NEW.user_id,
    'notificationId', NEW.id
  )::text);

  RETURN NULL;
END
$$;

CREATE TRIGGER notifications_publish
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION publish_notification();
