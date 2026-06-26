const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const TIMELINE_ADMIN_TOKEN = process.env.TIMELINE_ADMIN_TOKEN || "timeline-admin-123";
const TIMELINE_MATCH_TOLERANCE_MS = 5000;
const LOW_CONFIDENCE_REVIEW_THRESHOLD = 0.25;

if (!DATABASE_URL) {
  console.warn("DATABASE_URL is not set. Timeline server needs a separate Supabase/PostgreSQL database.");
}

let schemaReady = false;
let schemaErrorMessage = "";

function getDatabaseUrlInfo() {
  try {
    const url = new URL(DATABASE_URL || "");
    return {
      protocol: url.protocol,
      user: decodeURIComponent(url.username || ""),
      hasPassword: Boolean(url.password),
      host: url.hostname,
      port: url.port || "(default)",
      database: url.pathname.replace(/^\//, "") || "(none)"
    };
  } catch (error) {
    return { error: "Invalid DATABASE_URL: " + error.message };
  }
}

console.log("Database URL info:", getDatabaseUrlInfo());

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 30000
});

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeYouTubeVideoId(value) {
  const text = String(value || "").trim();
  if (/^[a-zA-Z0-9_-]{6,20}$/.test(text)) {
    return text;
  }

  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();

    if (host.includes("youtu.be")) {
      return normalizeYouTubeVideoId(url.pathname.split("/").filter(Boolean)[0] || "");
    }

    if (host.includes("youtube.com")) {
      const watchId = url.searchParams.get("v");
      if (watchId) {
        return normalizeYouTubeVideoId(watchId);
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if ((parts[0] === "shorts" || parts[0] === "embed") && parts[1]) {
        return normalizeYouTubeVideoId(parts[1]);
      }
    }
  } catch {
    return "";
  }

  return "";
}

function normalizeTimelineKey(value) {
  const key = String(value || "").trim();
  const aliases = {
    "DB": "C#",
    "EB": "D#",
    "GB": "F#",
    "AB": "G#",
    "BB": "A#"
  };
  const normalized = key.replace("\u266f", "#").replace("\u266d", "B").toUpperCase();
  return aliases[normalized] || normalized;
}

function normalizeScale(value) {
  const scale = String(value || "").trim().toLowerCase();
  if (scale.startsWith("min") || scale.includes("minor")) return "Minor";
  if (scale.startsWith("maj") || scale.includes("major")) return "Major";
  return scale ? scale.charAt(0).toUpperCase() + scale.slice(1) : "Major";
}

function normalizeMarkerType(value, index) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "initial_key" || type === "initial") return "initial_key";
  if (type === "modulation" || type === "change" || type === "key_change") return "modulation";
  return index === 0 ? "initial_key" : "modulation";
}

function parseTimelineMarkers(markers) {
  if (!Array.isArray(markers)) {
    return [];
  }

  return markers
    .map((marker, index) => ({
      timeMs: Math.max(0, Math.floor(Number(marker.timeMs || marker.time_ms || 0))),
      key: normalizeTimelineKey(marker.key),
      scale: normalizeScale(marker.scale),
      markerType: normalizeMarkerType(marker.markerType || marker.marker_type, index),
      confidence: Math.max(0, Math.min(1, Number(marker.confidence ?? 1)))
    }))
    .filter(marker => marker.key && marker.scale)
    .sort((a, b) => a.timeMs - b.timeMs)
    .slice(0, 64);
}

function parseAdminMarkerTimeMs(body) {
  if (body && body.timeMs !== undefined) {
    const timeMs = Math.floor(Number(body.timeMs));
    return Number.isFinite(timeMs) ? Math.max(0, timeMs) : null;
  }

  const text = String(body?.timeText || body?.time || "").trim();
  if (!text) {
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.max(0, Math.round(Number(text) * 1000));
  }

  const parts = text.split(":").map(part => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+(\.\d+)?$/.test(part))) {
    return null;
  }

  const numbers = parts.map(Number);
  const seconds = parts.length === 3
    ? (numbers[0] * 3600) + (numbers[1] * 60) + numbers[2]
    : (numbers[0] * 60) + numbers[1];
  return Math.max(0, Math.round(seconds * 1000));
}

function checkTimelineAdminToken(req, res) {
  const body = req.body || {};
  const query = req.query || {};
  const adminToken = body.adminToken || query.adminToken;

  if (adminToken !== TIMELINE_ADMIN_TOKEN) {
    res.status(403).json({ ok: false, message: "Sai timeline admin token" });
    return false;
  }

  return true;
}

function clusterConfidence(cluster, timelineCount) {
  if (!timelineCount) return 0;
  const agreement = Math.min(1, cluster.supportCount / timelineCount);
  const scoreBoost = Math.min(0.2, Math.max(0, cluster.score - cluster.supportCount) / Math.max(1, timelineCount * 10));
  return Math.round(Math.min(1, agreement + scoreBoost) * 100) / 100;
}

function aggregateTimelineMarkers(rows, timelineCount) {
  const clusters = [];

  for (const row of rows) {
    const marker = {
      timeMs: Number(row.time_ms || 0),
      key: normalizeTimelineKey(row.key),
      scale: normalizeScale(row.scale),
      markerType: row.marker_type || "modulation",
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 1))),
      machineId: String(row.created_by_machine_id || "").trim(),
      adminApproved: row.admin_approved === true || String(row.admin_approved).toLowerCase() === "true",
      confirmationStatus: String(row.confirmation_status || "pending").toLowerCase(),
      confirmationSupportCount: Math.max(0, Number(row.confirmation_support_count || 0))
    };

    const voteUp = Math.max(0, Number(row.vote_up || 0));
    const voteDown = Math.max(0, Number(row.vote_down || 0));
    const useCount = Math.max(0, Number(row.use_count || 0));
    const weight = Math.max(0.25, 1 + voteUp * 2 - voteDown * 3 + useCount * 0.25) * marker.confidence;

    let cluster = clusters.find(item =>
      item.key === marker.key &&
      item.scale === marker.scale &&
      item.markerType === marker.markerType &&
      Math.abs(item.anchorTimeMs - marker.timeMs) <= TIMELINE_MATCH_TOLERANCE_MS
    );

    if (!cluster) {
      cluster = {
        anchorTimeMs: marker.timeMs,
        timeMs: marker.timeMs,
        key: marker.key,
        scale: marker.scale,
        markerType: marker.markerType,
        score: 0,
        supportCount: 0,
        adminApproved: false,
        confirmationStatus: marker.markerType === "initial_key" && marker.confirmationStatus !== "rejected" ? "verified" : "pending",
        confirmed: marker.markerType === "initial_key" && marker.confirmationStatus !== "rejected",
        timeCandidates: []
      };
      clusters.push(cluster);
    }

    let candidate = cluster.timeCandidates.find(item =>
      Math.abs(item.anchorTimeMs - marker.timeMs) <= 1000
    );
    if (!candidate) {
      candidate = {
        anchorTimeMs: marker.timeMs,
        selectedTimeMs: marker.timeMs,
        selectedWeight: weight,
        score: 0,
        supportCount: 0,
        adminApproved: false,
        confirmationStatus: "pending",
        confirmationSupportCount: 0,
        machineWeights: new Map()
      };
      cluster.timeCandidates.push(candidate);
    }

    candidate.adminApproved = candidate.adminApproved || marker.adminApproved;
    if (marker.confirmationStatus === "verified") {
      candidate.confirmationStatus = "verified";
    } else if (marker.confirmationStatus === "rejected" && candidate.confirmationStatus !== "verified") {
      candidate.confirmationStatus = "rejected";
    }
    candidate.confirmationSupportCount = Math.max(
      candidate.confirmationSupportCount,
      marker.confirmationSupportCount);
    const machineKey = marker.machineId || "unknown-machine";
    const previousMachineWeight = candidate.machineWeights.get(machineKey) || 0;
    if (weight > previousMachineWeight) {
      candidate.machineWeights.set(machineKey, weight);
      candidate.score += weight - previousMachineWeight;
    }
    candidate.supportCount = candidate.machineWeights.size;
    if (weight > candidate.selectedWeight) {
      candidate.selectedWeight = weight;
      candidate.selectedTimeMs = marker.timeMs;
    }

    const winner = cluster.timeCandidates
      .slice()
      .sort((left, right) =>
        Number(right.confirmationStatus === "verified") - Number(left.confirmationStatus === "verified") ||
        Number(left.confirmationStatus === "rejected") - Number(right.confirmationStatus === "rejected") ||
        right.supportCount - left.supportCount ||
        right.score - left.score ||
        right.selectedWeight - left.selectedWeight ||
        left.selectedTimeMs - right.selectedTimeMs)[0];
    cluster.timeMs = winner.selectedTimeMs;
    cluster.score = winner.score;
    cluster.supportCount = marker.markerType === "initial_key"
      ? winner.supportCount
      : winner.confirmationSupportCount;
    cluster.adminApproved = winner.adminApproved;
    cluster.confirmationStatus = marker.markerType === "initial_key"
      ? (winner.confirmationStatus === "rejected" ? "rejected" : "verified")
      : winner.confirmationStatus;
    cluster.confirmed = cluster.confirmationStatus === "verified";
  }

  const aggregateMarkers = clusters
    .filter(cluster => (cluster.score >= LOW_CONFIDENCE_REVIEW_THRESHOLD || cluster.adminApproved) && cluster.confirmed)
    .sort((a, b) => a.timeMs - b.timeMs || b.score - a.score)
    .reduce((markers, cluster) => {
      const previous = markers[markers.length - 1];
      if (previous &&
          previous.key === cluster.key &&
          previous.scale === cluster.scale &&
          previous.markerType === cluster.markerType &&
          Math.abs(previous.timeMs - cluster.timeMs) <= TIMELINE_MATCH_TOLERANCE_MS) {
        if (cluster.score > previous.score) {
          markers[markers.length - 1] = cluster;
        }
        return markers;
      }

      markers.push(cluster);
      return markers;
    }, [])
    .map(cluster => ({
      timeMs: cluster.timeMs,
      key: cluster.key,
      scale: cluster.scale,
      markerType: cluster.markerType,
      confidence: cluster.adminApproved ? 1 : clusterConfidence(cluster, timelineCount),
      supportCount: cluster.supportCount,
      adminApproved: cluster.adminApproved,
      confirmed: cluster.confirmed,
      confirmationStatus: cluster.confirmationStatus
    }));

  const initialMarker = aggregateMarkers
    .filter(marker => marker.markerType === "initial_key")
    .sort((left, right) =>
      right.confidence - left.confidence ||
      right.supportCount - left.supportCount ||
      left.timeMs - right.timeMs)[0];
  if (!initialMarker) {
    return aggregateMarkers;
  }

  return aggregateMarkers.filter(marker =>
    marker.markerType === "initial_key" ||
    marker.key !== initialMarker.key ||
    marker.scale !== initialMarker.scale
  );
}

function formatAggregateSummary(markers) {
  if (!Array.isArray(markers) || markers.length === 0) {
    return "Chua co ket qua";
  }

  return markers
    .slice(0, 4)
    .map(marker => {
      const percent = Math.round(Math.max(0, Math.min(1, Number(marker.confidence || 0))) * 100);
      const time = formatDuration(Number(marker.timeMs || 0) / 1000);
      const label = marker.markerType === "initial_key" ? "dau bai" : "len tone";
      return `${label} ${marker.key} ${marker.scale} ${percent}% @ ${time}`;
    })
    .join("; ");
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

async function ensureSchema() {
  await pool.query(`
    create table if not exists songs (
      id bigserial primary key,
      youtube_video_id text unique not null,
      title text not null default '',
      artist text not null default '',
      duration_seconds integer not null default 0,
      created_at bigint not null,
      updated_at bigint not null
    )
  `);

  await pool.query(`
    create table if not exists song_timelines (
      id bigserial primary key,
      song_id bigint not null references songs(id) on delete cascade,
      created_by_machine_id text not null default '',
      source text not null default 'community',
      vote_up integer not null default 0,
      vote_down integer not null default 0,
      use_count integer not null default 0,
      created_at bigint not null,
      updated_at bigint not null
    )
  `);

  await pool.query(`
    create table if not exists timeline_markers (
      id bigserial primary key,
      timeline_id bigint not null references song_timelines(id) on delete cascade,
      time_ms integer not null,
      key text not null,
      scale text not null,
      marker_type text not null default 'modulation',
      confidence real not null default 1
    )
  `);

  await pool.query(`
    create table if not exists timeline_votes (
      id bigserial primary key,
      timeline_id bigint not null references song_timelines(id) on delete cascade,
      machine_id text not null,
      vote integer not null check (vote in (-1, 1)),
      created_at bigint not null,
      unique (timeline_id, machine_id)
    )
  `);

  await pool.query(
    "alter table timeline_markers add column if not exists admin_approved boolean not null default false"
  );
  await pool.query(
    "alter table timeline_markers add column if not exists confirmation_status text not null default 'pending'"
  );
  await pool.query(
    "alter table timeline_markers add column if not exists confirmation_support_count integer not null default 0"
  );
  await pool.query(`
    update timeline_markers
    set key = case upper(trim(key))
      when 'DB' then 'C#'
      when 'EB' then 'D#'
      when 'GB' then 'F#'
      when 'AB' then 'G#'
      when 'BB' then 'A#'
      else key
    end
    where upper(trim(key)) in ('DB', 'EB', 'GB', 'AB', 'BB')
  `);
  await pool.query(`
    create table if not exists timeline_server_settings (
      setting_key text primary key,
      setting_value text not null,
      updated_at bigint not null
    )
  `);
  const confirmationMigration = await pool.query(
    `insert into timeline_server_settings (setting_key, setting_value, updated_at)
     values ('modulation_confirmation_v1_migrated', 'true', $1)
     on conflict (setting_key) do nothing
     returning setting_key`,
    [nowSeconds()]
  );
  if (confirmationMigration.rows.length > 0) {
    await pool.query(
      `update timeline_markers
       set confirmation_status = 'verified'
       where marker_type = 'modulation'`
    );
  }

  await pool.query("create index if not exists idx_song_timelines_song_id on song_timelines(song_id)");
  await pool.query("create index if not exists idx_timeline_markers_timeline_id on timeline_markers(timeline_id)");
  await pool.query("create index if not exists idx_timeline_votes_timeline_id on timeline_votes(timeline_id)");
  await backfillModulationConfirmations();
}

async function refreshModulationConfirmation(db, songId, key, scale, timeMs) {
  const result = await db.query(
    `select m.id, m.confirmation_status, m.admin_approved, t.created_by_machine_id
     from timeline_markers m
     join song_timelines t on t.id = m.timeline_id
     where t.song_id = $1
       and m.marker_type = 'modulation'
       and m.key = $2
       and m.scale = $3
       and abs(m.time_ms - $4) <= 1000
     order by m.id asc
     for update`,
    [songId, key, scale, timeMs]
  );
  if (result.rows.length === 0) return null;

  const machineIds = new Set(result.rows
    .map(row => String(row.created_by_machine_id || "").trim())
    .filter(Boolean));
  const supportCount = machineIds.size;
  const wasVerified = result.rows.some(row => row.admin_approved || row.confirmation_status === "verified");
  const wasRejected = result.rows.some(row => row.confirmation_status === "rejected");
  const status = wasVerified
    ? "verified"
    : wasRejected
      ? "rejected"
      : supportCount >= 3 ? "verified" : "pending";
  const markerIds = result.rows.map(row => row.id);
  await db.query(
    `update timeline_markers
     set confirmation_status = $2, confirmation_support_count = $3
     where id = any($1::bigint[])`,
    [markerIds, status, supportCount]
  );
  return { status, supportCount, markerIds };
}

async function backfillModulationConfirmations() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `select t.song_id, m.key, m.scale, m.time_ms
       from timeline_markers m
       join song_timelines t on t.id = m.timeline_id
       where m.marker_type = 'modulation'
       order by t.song_id, m.key, m.scale, m.time_ms`
    );
    for (const row of result.rows) {
      await refreshModulationConfirmation(client, row.song_id, row.key, row.scale, row.time_ms);
    }
    await client.query(
      `update timeline_markers
       set confirmation_status = 'verified', confirmation_support_count = greatest(1, confirmation_support_count)
       where marker_type = 'initial_key'`
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function getSongByYouTubeVideoId(videoId) {
  const result = await pool.query("select * from songs where youtube_video_id = $1", [videoId]);
  return result.rows[0] || null;
}

async function upsertSong({ youtubeVideoId, title, artist, durationSeconds }) {
  const now = nowSeconds();
  const result = await pool.query(
    `insert into songs (youtube_video_id, title, artist, duration_seconds, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$5)
     on conflict (youtube_video_id) do update set
       title = case when excluded.title <> '' then excluded.title else songs.title end,
       artist = case when excluded.artist <> '' then excluded.artist else songs.artist end,
       duration_seconds = case when excluded.duration_seconds > 0 then excluded.duration_seconds else songs.duration_seconds end,
       updated_at = excluded.updated_at
     returning *`,
    [
      youtubeVideoId,
      String(title || "").trim().slice(0, 300),
      String(artist || "").trim().slice(0, 200),
      Math.max(0, Math.floor(Number(durationSeconds || 0))),
      now
    ]
  );
  return result.rows[0];
}

async function updateTimelineVoteCounts(timelineId) {
  const counts = await pool.query(
    `select
       count(*) filter (where vote = 1) as vote_up,
       count(*) filter (where vote = -1) as vote_down
     from timeline_votes
     where timeline_id = $1`,
    [timelineId]
  );

  const voteUp = Number(counts.rows[0]?.vote_up || 0);
  const voteDown = Number(counts.rows[0]?.vote_down || 0);
  await pool.query(
    "update song_timelines set vote_up = $2, vote_down = $3, updated_at = $4 where id = $1",
    [timelineId, voteUp, voteDown, nowSeconds()]
  );

  return { voteUp, voteDown };
}

async function loadCommunityTimeline(videoId) {
  const song = await getSongByYouTubeVideoId(videoId);
  if (!song) {
    return null;
  }

  const timelineCountResult = await pool.query(
    "select count(*)::int as count from song_timelines where song_id = $1",
    [song.id]
  );
  const timelineCount = Number(timelineCountResult.rows[0]?.count || 0);

  const bestTimelineResult = await pool.query(
    `select *
     from song_timelines
     where song_id = $1
     order by (vote_up * 2 - vote_down * 4 + use_count) desc, updated_at desc
     limit 1`,
    [song.id]
  );
  const bestTimeline = bestTimelineResult.rows[0] || null;

  const markerRows = await pool.query(
    `select
       m.id as marker_id, m.time_ms, m.key, m.scale, m.marker_type, m.confidence, m.admin_approved,
       m.confirmation_status, m.confirmation_support_count,
       t.id as timeline_id, t.created_by_machine_id, t.vote_up, t.vote_down, t.use_count
     from timeline_markers m
     join song_timelines t on t.id = m.timeline_id
     where t.song_id = $1
     order by m.time_ms asc`,
    [song.id]
  );

  const markers = aggregateTimelineMarkers(markerRows.rows, timelineCount);

  return {
    songId: String(song.id),
    youtubeVideoId: song.youtube_video_id,
    title: song.title || "",
    artist: song.artist || "",
    durationSeconds: Number(song.duration_seconds || 0),
    timelineId: bestTimeline ? String(bestTimeline.id) : "",
    timelineCount,
    markers
  };
}

async function listTimelineSongs(searchText = "") {
  const search = String(searchText || "").trim();
  const values = [];
  let whereSql = "";
  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    whereSql = `where lower(s.youtube_video_id) like $1
      or lower(s.title) like $1
      or lower(s.artist) like $1`;
  }

  const result = await pool.query(
    `with filtered_songs as (
       select s.*
       from songs s
       ${whereSql}
     ),
     timeline_stats as (
       select
         song_id,
         count(*)::int as timeline_count,
         coalesce(sum(vote_up), 0)::int as vote_up,
         coalesce(sum(vote_down), 0)::int as vote_down,
         coalesce(sum(use_count), 0)::int as use_count,
         max(updated_at) as last_timeline_at
       from song_timelines
       where song_id in (select id from filtered_songs)
       group by song_id
     ),
     marker_stats as (
       select
         t.song_id,
         count(m.id)::int as marker_count,
         count(m.id) filter (
           where m.marker_type = 'modulation'
             and coalesce(m.confirmation_status, 'pending') = 'pending'
         )::int as pending_modulation_count
         ,
         count(m.id) filter (
           where coalesce(m.confirmation_status, 'pending') = 'pending'
             and coalesce(m.confidence, 1) < $${values.length + 1}
         )::int as pending_low_confidence_count
       from song_timelines t
       left join timeline_markers m on m.timeline_id = t.id
       where t.song_id in (select id from filtered_songs)
       group by t.song_id
     )
     select
       s.id,
       s.youtube_video_id,
       s.title,
       s.artist,
       s.duration_seconds,
       s.created_at,
       s.updated_at,
       coalesce(ts.timeline_count, 0)::int as timeline_count,
       coalesce(ms.marker_count, 0)::int as marker_count,
       coalesce(ms.pending_modulation_count, 0)::int as pending_modulation_count,
       coalesce(ms.pending_low_confidence_count, 0)::int as pending_low_confidence_count,
       coalesce(ts.vote_up, 0)::int as vote_up,
       coalesce(ts.vote_down, 0)::int as vote_down,
       coalesce(ts.use_count, 0)::int as use_count,
       ts.last_timeline_at
     from filtered_songs s
     left join timeline_stats ts on ts.song_id = s.id
     left join marker_stats ms on ms.song_id = s.id
     order by coalesce(ts.last_timeline_at, s.updated_at) desc
     limit 300`,
    [...values, LOW_CONFIDENCE_REVIEW_THRESHOLD]
  );

  const songs = result.rows.map(row => ({
    songId: String(row.id),
    youtubeVideoId: row.youtube_video_id || "",
    title: row.title || "",
    artist: row.artist || "",
    durationSeconds: Number(row.duration_seconds || 0),
    timelineCount: Number(row.timeline_count || 0),
    markerCount: Number(row.marker_count || 0),
    pendingModulationCount: Number(row.pending_modulation_count || 0),
    pendingLowConfidenceCount: Number(row.pending_low_confidence_count || 0),
    voteUp: Number(row.vote_up || 0),
    voteDown: Number(row.vote_down || 0),
    useCount: Number(row.use_count || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    lastTimelineAt: Number(row.last_timeline_at || 0),
    aggregateMarkers: [],
    aggregateSummary: "Chua co ket qua"
  }));

  if (songs.length === 0) {
    return songs;
  }

  const songIds = songs.map(song => Number(song.songId));
  const markerResult = await pool.query(
    `select
       t.song_id,
       m.id as marker_id, m.time_ms, m.key, m.scale, m.marker_type, m.confidence, m.admin_approved,
       m.confirmation_status, m.confirmation_support_count,
       t.id as timeline_id, t.created_by_machine_id, t.vote_up, t.vote_down, t.use_count
     from timeline_markers m
     join song_timelines t on t.id = m.timeline_id
     where t.song_id = any($1::bigint[])
     order by t.song_id asc, m.time_ms asc`,
    [songIds]
  );

  const markersBySong = new Map();
  for (const row of markerResult.rows) {
    const key = String(row.song_id);
    if (!markersBySong.has(key)) {
      markersBySong.set(key, []);
    }

    markersBySong.get(key).push(row);
  }

  for (const song of songs) {
    const markers = aggregateTimelineMarkers(
      markersBySong.get(song.songId) || [],
      song.timelineCount);
    song.aggregateMarkers = markers;
    song.aggregateSummary = formatAggregateSummary(markers);
  }

  return songs;
}

async function getTimelineSongDetail(songId) {
  const normalizedSongId = Math.floor(Number(songId || 0));
  if (!normalizedSongId) {
    return null;
  }

  const songResult = await pool.query("select * from songs where id = $1", [normalizedSongId]);
  const song = songResult.rows[0];
  if (!song) {
    return null;
  }

  const timelineResult = await pool.query(
    `select *
     from song_timelines
     where song_id = $1
     order by updated_at desc, id desc`,
    [normalizedSongId]
  );

  const timelineIds = timelineResult.rows.map(row => row.id);
  let markerRows = [];
  if (timelineIds.length > 0) {
    const markerResult = await pool.query(
      `select
         m.*,
          t.song_id,
          t.created_by_machine_id,
          t.vote_up,
         t.vote_down,
         t.use_count
       from timeline_markers m
       join song_timelines t on t.id = m.timeline_id
       where m.timeline_id = any($1::bigint[])
       order by m.time_ms asc, m.id asc`,
      [timelineIds]
    );
    markerRows = markerResult.rows;
  }

  const markersByTimeline = new Map();
  for (const marker of markerRows) {
    const key = String(marker.timeline_id);
    if (!markersByTimeline.has(key)) {
      markersByTimeline.set(key, []);
    }

    markersByTimeline.get(key).push({
      markerId: String(marker.id),
      timeMs: Number(marker.time_ms || 0),
      key: marker.key || "",
      scale: marker.scale || "",
       markerType: marker.marker_type || "",
       confidence: Number(marker.confidence || 0),
       adminApproved: Boolean(marker.admin_approved),
       confirmationStatus: marker.confirmation_status || "pending",
       confirmationSupportCount: Number(marker.confirmation_support_count || 0)
    });
  }

  const aggregateMarkers = aggregateTimelineMarkers(markerRows, timelineResult.rows.length);

  return {
    songId: String(song.id),
    youtubeVideoId: song.youtube_video_id || "",
    title: song.title || "",
    artist: song.artist || "",
    durationSeconds: Number(song.duration_seconds || 0),
    timelineCount: timelineResult.rows.length,
    markerCount: markerRows.length,
    useCount: timelineResult.rows.reduce((total, row) => total + Number(row.use_count || 0), 0),
    aggregateMarkers,
    aggregateSummary: formatAggregateSummary(aggregateMarkers),
    createdAt: Number(song.created_at || 0),
    updatedAt: Number(song.updated_at || 0),
    timelines: timelineResult.rows.map(row => ({
      timelineId: String(row.id),
      source: row.source || "",
      createdByMachineId: row.created_by_machine_id || "",
      voteUp: Number(row.vote_up || 0),
      voteDown: Number(row.vote_down || 0),
      useCount: Number(row.use_count || 0),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      markers: markersByTimeline.get(String(row.id)) || []
    }))
  };
}

async function deleteTimeline(timelineId) {
  const normalizedTimelineId = Math.floor(Number(timelineId || 0));
  if (!normalizedTimelineId) {
    return false;
  }

  const result = await pool.query("delete from song_timelines where id = $1 returning id", [normalizedTimelineId]);
  return result.rows.length > 0;
}

async function updateTimelineMarker({ markerId, timeMs, key, scale }) {
  const normalizedMarkerId = Math.floor(Number(markerId || 0));
  if (!normalizedMarkerId) {
    return null;
  }

  const normalizedKey = normalizeTimelineKey(key);
  const normalizedScale = normalizeScale(scale);
  if (!normalizedKey || !normalizedScale || timeMs === null || timeMs === undefined) {
    return null;
  }

  const now = nowSeconds();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const markerResult = await client.query(
      `update timeline_markers
       set time_ms = $2, key = $3, scale = $4
       where id = $1
       returning id, timeline_id, time_ms, key, scale, marker_type, confidence`,
      [normalizedMarkerId, timeMs, normalizedKey, normalizedScale]
    );

    const marker = markerResult.rows[0];
    if (!marker) {
      await client.query("rollback");
      return null;
    }

    await client.query(
      "update song_timelines set updated_at = $2 where id = $1",
      [marker.timeline_id, now]
    );
    await client.query("commit");

    return {
      markerId: String(marker.id),
      timelineId: String(marker.timeline_id),
      timeMs: Number(marker.time_ms || 0),
      key: marker.key || "",
      scale: marker.scale || "",
      markerType: marker.marker_type || "",
      confidence: Number(marker.confidence || 0)
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function deleteTimelineSong(songId) {
  const normalizedSongId = Math.floor(Number(songId || 0));
  if (!normalizedSongId) {
    return false;
  }

  const result = await pool.query("delete from songs where id = $1 returning id", [normalizedSongId]);
  return result.rows.length > 0;
}

async function setTimelineMarkerConfirmation(markerId, requestedStatus) {
  const normalizedMarkerId = Math.floor(Number(markerId || 0));
  const status = String(requestedStatus || "").toLowerCase();
  if (!normalizedMarkerId || !["pending", "verified", "rejected"].includes(status)) return null;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const markerResult = await client.query(
      `select m.*, t.song_id
       from timeline_markers m
       join song_timelines t on t.id = m.timeline_id
       where m.id = $1
         and m.marker_type in ('initial_key', 'modulation')
       for update`,
      [normalizedMarkerId]
    );
    const marker = markerResult.rows[0];
    if (!marker) {
      await client.query("rollback");
      return null;
    }
    await client.query("select pg_advisory_xact_lock($1::bigint)", [marker.song_id]);
    const groupResult = await client.query(
      `update timeline_markers m
       set confirmation_status = $5,
           admin_approved = ($5 = 'verified')
       from song_timelines t
       where m.timeline_id = t.id
         and t.song_id = $1
         and m.marker_type = $6
         and m.key = $2
         and m.scale = $3
         and abs(m.time_ms - $4) <= 1000
       returning m.id`,
      [marker.song_id, marker.key, marker.scale, marker.time_ms, status, marker.marker_type]
    );
    await client.query("commit");
    return {
      markerId: String(marker.id),
      timelineId: String(marker.timeline_id),
      status,
      affectedMarkers: groupResult.rows.length
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const TIMELINE_BACKUP_COLUMNS = [
  "format_version", "record_type", "song_backup_id", "youtube_video_id", "song_title", "artist",
  "duration_seconds", "song_created_at", "song_updated_at", "timeline_backup_id",
  "created_by_machine_id", "source", "vote_up", "vote_down", "use_count",
  "timeline_created_at", "timeline_updated_at", "marker_backup_id", "time_ms", "key", "scale",
  "marker_type", "confidence", "admin_approved", "confirmation_status", "confirmation_support_count",
  "vote_backup_id", "machine_id", "vote", "vote_created_at"
];

function escapeCsvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeCsv(rows) {
  const lines = [TIMELINE_BACKUP_COLUMNS.map(escapeCsvValue).join(",")];
  for (const row of rows) {
    lines.push(TIMELINE_BACKUP_COLUMNS.map(column => escapeCsvValue(row[column])).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV co o du lieu chua dong dau ngoac kep.");
  row.push(field.replace(/\r$/, ""));
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

function csvRowsToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV khong co du lieu backup.");
  const headers = rows[0].map(value => value.trim());
  for (const required of ["format_version", "record_type", "song_backup_id", "youtube_video_id"]) {
    if (!headers.includes(required)) throw new Error(`CSV thieu cot bat buoc: ${required}`);
  }
  if (rows.length > 100001) throw new Error("CSV vuot qua gioi han 100000 dong du lieu.");
  return rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function backupNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function buildTimelineBackupCsv() {
  const [songResult, timelineResult, markerResult, voteResult] = await Promise.all([
    pool.query("select * from songs order by id asc"),
    pool.query("select * from song_timelines order by id asc"),
    pool.query("select * from timeline_markers order by id asc"),
    pool.query("select * from timeline_votes order by id asc")
  ]);
  const rows = [];
  for (const song of songResult.rows) {
    rows.push({
      format_version: "1", record_type: "song", song_backup_id: song.id,
      youtube_video_id: song.youtube_video_id, song_title: song.title, artist: song.artist,
      duration_seconds: song.duration_seconds, song_created_at: song.created_at, song_updated_at: song.updated_at
    });
  }
  for (const timeline of timelineResult.rows) {
    rows.push({
      format_version: "1", record_type: "timeline", song_backup_id: timeline.song_id,
      timeline_backup_id: timeline.id, created_by_machine_id: timeline.created_by_machine_id,
      source: timeline.source, vote_up: timeline.vote_up, vote_down: timeline.vote_down,
      use_count: timeline.use_count, timeline_created_at: timeline.created_at,
      timeline_updated_at: timeline.updated_at
    });
  }
  for (const marker of markerResult.rows) {
    rows.push({
      format_version: "1", record_type: "marker", timeline_backup_id: marker.timeline_id,
      marker_backup_id: marker.id, time_ms: marker.time_ms, key: marker.key, scale: marker.scale,
      marker_type: marker.marker_type, confidence: marker.confidence, admin_approved: marker.admin_approved,
      confirmation_status: marker.confirmation_status,
      confirmation_support_count: marker.confirmation_support_count
    });
  }
  for (const vote of voteResult.rows) {
    rows.push({
      format_version: "1", record_type: "vote", timeline_backup_id: vote.timeline_id,
      vote_backup_id: vote.id, machine_id: vote.machine_id, vote: vote.vote, vote_created_at: vote.created_at
    });
  }
  return serializeCsv(rows);
}

async function importTimelineBackupCsv(csvText) {
  const rows = csvRowsToObjects(csvText);
  if (rows.some(row => row.format_version !== "1")) throw new Error("CSV co phien ban backup khong duoc ho tro.");
  const validTypes = new Set(["song", "timeline", "marker", "vote"]);
  if (rows.some(row => !validTypes.has(row.record_type))) throw new Error("CSV co record_type khong hop le.");

  const songRows = rows.filter(row => row.record_type === "song");
  const timelineRows = rows.filter(row => row.record_type === "timeline");
  const markerRows = rows.filter(row => row.record_type === "marker");
  const voteRows = rows.filter(row => row.record_type === "vote");
  if (songRows.length === 0) throw new Error("CSV khong co dong song nao.");

  const client = await pool.connect();
  try {
    await client.query("begin");
    const songIdMap = new Map();
    for (const row of songRows) {
      const videoId = normalizeYouTubeVideoId(row.youtube_video_id);
      if (!videoId || !row.song_backup_id) throw new Error("Dong song thieu YouTube ID hoac song_backup_id.");
      const createdAt = Math.max(0, Math.floor(backupNumber(row.song_created_at, nowSeconds())));
      const updatedAt = Math.max(createdAt, Math.floor(backupNumber(row.song_updated_at, createdAt)));
      const result = await client.query(
        `insert into songs (youtube_video_id, title, artist, duration_seconds, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (youtube_video_id) do update set
           title=excluded.title, artist=excluded.artist, duration_seconds=excluded.duration_seconds,
           created_at=excluded.created_at, updated_at=excluded.updated_at
         returning id`,
        [videoId, String(row.song_title || "").slice(0, 300), String(row.artist || "").slice(0, 200),
          Math.max(0, Math.floor(backupNumber(row.duration_seconds))), createdAt, updatedAt]
      );
      const songId = result.rows[0].id;
      songIdMap.set(String(row.song_backup_id), songId);
      await client.query("delete from song_timelines where song_id = $1", [songId]);
    }

    const timelineIdMap = new Map();
    const timelineSongIdMap = new Map();
    for (const row of timelineRows) {
      const songId = songIdMap.get(String(row.song_backup_id));
      if (!songId || !row.timeline_backup_id) throw new Error("Timeline tham chieu song khong ton tai trong CSV.");
      const createdAt = Math.max(0, Math.floor(backupNumber(row.timeline_created_at, nowSeconds())));
      const updatedAt = Math.max(createdAt, Math.floor(backupNumber(row.timeline_updated_at, createdAt)));
      const result = await client.query(
        `insert into song_timelines
           (song_id, created_by_machine_id, source, vote_up, vote_down, use_count, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [songId, String(row.created_by_machine_id || "").slice(0, 200), String(row.source || "community").slice(0, 80),
          Math.max(0, Math.floor(backupNumber(row.vote_up))), Math.max(0, Math.floor(backupNumber(row.vote_down))),
          Math.max(0, Math.floor(backupNumber(row.use_count))), createdAt, updatedAt]
      );
      timelineIdMap.set(String(row.timeline_backup_id), result.rows[0].id);
      timelineSongIdMap.set(String(row.timeline_backup_id), songId);
    }

    for (const row of markerRows) {
      const timelineId = timelineIdMap.get(String(row.timeline_backup_id));
      const songId = timelineSongIdMap.get(String(row.timeline_backup_id));
      if (!timelineId) throw new Error("Marker tham chieu timeline khong ton tai trong CSV.");
      const timeMs = Math.max(0, Math.floor(backupNumber(row.time_ms)));
      const key = normalizeTimelineKey(row.key);
      const scale = normalizeScale(row.scale);
      const markerType = normalizeMarkerType(row.marker_type, 0);
      await client.query(
        `insert into timeline_markers
           (timeline_id, time_ms, key, scale, marker_type, confidence, admin_approved,
            confirmation_status, confirmation_support_count)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [timelineId, timeMs, key, scale, markerType,
          Math.max(0, Math.min(1, backupNumber(row.confidence, 1))),
          String(row.admin_approved).toLowerCase() === "true",
          ["pending", "verified", "rejected"].includes(String(row.confirmation_status).toLowerCase())
            ? String(row.confirmation_status).toLowerCase()
            : "pending",
          Math.max(0, Math.floor(backupNumber(row.confirmation_support_count)))]
      );
      if (markerType === "modulation") {
        await refreshModulationConfirmation(client, songId, key, scale, timeMs);
      }
    }

    for (const row of voteRows) {
      const timelineId = timelineIdMap.get(String(row.timeline_backup_id));
      const vote = Math.sign(Math.floor(backupNumber(row.vote)));
      if (!timelineId || !row.machine_id || ![-1, 1].includes(vote)) throw new Error("Dong vote trong CSV khong hop le.");
      await client.query(
        `insert into timeline_votes (timeline_id, machine_id, vote, created_at)
         values ($1,$2,$3,$4)
         on conflict (timeline_id, machine_id) do update set vote=excluded.vote, created_at=excluded.created_at`,
        [timelineId, String(row.machine_id).slice(0, 200), vote,
          Math.max(0, Math.floor(backupNumber(row.vote_created_at, nowSeconds())))]
      );
    }
    await client.query("commit");
    return { songs: songRows.length, timelines: timelineRows.length, markers: markerRows.length, votes: voteRows.length };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

app.get("/privacy/youtube-sync", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chính sách quyền riêng tư - PluginLocker YouTube Sync</title>
  <style>
    body{margin:0;background:#0b0e15;color:#e8edf5;font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
    main{max-width:820px;margin:0 auto;padding:48px 24px 72px}
    h1{font-size:32px;line-height:1.2;margin:0 0 8px}h2{font-size:21px;margin:34px 0 8px}
    .date{color:#9aa8ba;margin-bottom:34px}p,li{color:#cbd5e1}strong{color:#fff}
    .card{background:#121722;border:1px solid #263044;border-radius:14px;padding:22px 24px;margin:22px 0}
    code{color:#72c7ff}a{color:#72c7ff}
  </style>
</head>
<body><main>
  <h1>Chính sách quyền riêng tư</h1>
  <div class="date">PluginLocker YouTube Sync · Cập nhật ngày 22/06/2026</div>

  <div class="card"><strong>Tóm tắt:</strong> Extension chỉ đồng bộ thông tin phát YouTube với ứng dụng PluginLockerWin chạy trên cùng máy tính. Extension không bán dữ liệu và không gửi dữ liệu duyệt web trực tiếp tới máy chủ bên ngoài.</div>

  <h2>1. Mục đích duy nhất</h2>
  <p>PluginLocker YouTube Sync được sử dụng để đồng bộ video YouTube đang phát với ứng dụng PluginLockerWin cài trên cùng thiết bị.</p>

  <h2>2. Dữ liệu được xử lý</h2>
  <p>Khi người dùng mở YouTube, extension có thể xử lý:</p>
  <ul>
    <li>URL YouTube và mã video;</li>
    <li>tiêu đề video;</li>
    <li>thời gian phát hiện tại và tổng thời lượng;</li>
    <li>trạng thái phát, tạm dừng hoặc tua video.</li>
  </ul>

  <h2>3. Cách sử dụng và truyền dữ liệu</h2>
  <p>Dữ liệu trên chỉ được dùng để hiển thị tên beat, thời gian và đồng bộ timeline trong PluginLockerWin. Extension truyền dữ liệu qua WebSocket nội bộ tới <code>127.0.0.1:9999</code> hoặc <code>localhost:9999</code> trên cùng máy tính.</p>
  <p>Extension không trực tiếp gửi dữ liệu này tới máy chủ bên ngoài, không bán, không cho thuê và không sử dụng dữ liệu cho quảng cáo, đánh giá tín dụng hoặc mục đích không liên quan.</p>

  <h2>4. Lưu trữ và chia sẻ</h2>
  <p>Extension không tạo cơ sở dữ liệu lịch sử duyệt web và không chia sẻ dữ liệu với bên thứ ba. Trạng thái gần nhất có thể được giữ tạm thời trong bộ nhớ của extension để hiển thị tình trạng kết nối và sẽ mất khi tiến trình extension kết thúc.</p>

  <h2>5. Quyền của trình duyệt</h2>
  <ul>
    <li><strong>tabs:</strong> xác định đúng tab YouTube đang phát khi có nhiều tab.</li>
    <li><strong>scripting:</strong> đọc trạng thái phần tử video YouTube.</li>
    <li><strong>youtube.com:</strong> giới hạn hoạt động của extension trên các trang YouTube.</li>
  </ul>

  <h2>6. Bảo mật và thay đổi chính sách</h2>
  <p>Extension chỉ chấp nhận kết nối cục bộ với PluginLockerWin. Chính sách này có thể được cập nhật khi chức năng hoặc cách xử lý dữ liệu thay đổi; ngày cập nhật mới nhất luôn được ghi ở đầu trang.</p>

  <h2>7. Liên hệ</h2>
  <p>Nếu có câu hỏi về quyền riêng tư, người dùng có thể liên hệ nhà phát triển PHU TRAN TPA qua kênh hỗ trợ được cung cấp cùng ứng dụng PluginLockerWin.</p>
</main></body></html>`);
});

app.get("/", (req, res) => {
  res.send("PluginLocker timeline server is running.");
});

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true, service: "timeline", db: true, schemaReady, time: nowSeconds() });
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: "timeline",
      db: false,
      schemaReady,
      message: error.message,
      schemaError: schemaErrorMessage,
      databaseUrlInfo: getDatabaseUrlInfo(),
      time: nowSeconds()
    });
  }
});

app.get("/api/song-timelines/youtube/:videoId", async (req, res) => {
  try {
    const videoId = normalizeYouTubeVideoId(req.params.videoId);
    if (!videoId) {
      return res.status(400).json({ ok: false, message: "Invalid YouTube video ID." });
    }

    const timeline = await loadCommunityTimeline(videoId);
    if (!timeline || timeline.markers.length === 0) {
      return res.status(404).json({ ok: false, message: "No community timeline found.", timeline: null });
    }

    return res.json({ ok: true, message: "Community timeline found.", timeline });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Timeline server error: " + error.message });
  }
});

app.post("/api/song-timelines", async (req, res) => {
  let client;

  try {
    const body = req.body || {};
    const youtubeVideoId = normalizeYouTubeVideoId(body.youtubeVideoId || body.youtubeUrl || body.url);
    const markers = parseTimelineMarkers(body.markers);

    if (!youtubeVideoId) {
      return res.status(400).json({ ok: false, message: "Missing or invalid YouTube video ID." });
    }

    if (markers.length === 0) {
      return res.status(400).json({ ok: false, message: "Timeline needs at least one marker." });
    }

    const song = await upsertSong({
      youtubeVideoId,
      title: body.title,
      artist: body.artist,
      durationSeconds: body.durationSeconds
    });

    const now = nowSeconds();
    client = await pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1::bigint)", [song.id]);
    const timelineResult = await client.query(
      `insert into song_timelines (song_id, created_by_machine_id, source, created_at, updated_at)
       values ($1,$2,$3,$4,$4)
       returning *`,
      [
        song.id,
        String(body.machineId || body.machineID || "").trim().slice(0, 200),
        String(body.source || "community").trim().slice(0, 40),
        now
      ]
    );

    const timeline = timelineResult.rows[0];
    for (const marker of markers) {
      await client.query(
        `insert into timeline_markers (timeline_id, time_ms, key, scale, marker_type, confidence)
         values ($1,$2,$3,$4,$5,$6)`,
        [timeline.id, marker.timeMs, marker.key, marker.scale, marker.markerType, marker.confidence]
      );
      if (marker.markerType === "modulation") {
        await refreshModulationConfirmation(
          client,
          song.id,
          marker.key,
          marker.scale,
          marker.timeMs);
      }
    }

    await client.query("commit");
    client.release();
    client = null;

    const communityTimeline = await loadCommunityTimeline(youtubeVideoId);
    return res.json({
      ok: true,
      message: "Timeline uploaded.",
      timelineId: String(timeline.id),
      timeline: communityTimeline
    });
  } catch (error) {
    if (client) {
      await client.query("rollback").catch(() => {});
    }
    return res.status(500).json({ ok: false, message: "Timeline upload failed: " + error.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

app.post("/api/song-timelines/:timelineId/vote", async (req, res) => {
  try {
    const timelineId = Math.floor(Number(req.params.timelineId || 0));
    const body = req.body || {};
    const machineId = String(body.machineId || body.machineID || "").trim().slice(0, 200);
    const voteValue = body.vote === "down" || Number(body.vote) < 0 ? -1 : 1;

    if (!timelineId) {
      return res.status(400).json({ ok: false, message: "Invalid timeline ID." });
    }

    if (!machineId) {
      return res.status(400).json({ ok: false, message: "Missing machine ID." });
    }

    await pool.query(
      `insert into timeline_votes (timeline_id, machine_id, vote, created_at)
       values ($1,$2,$3,$4)
       on conflict (timeline_id, machine_id) do update set
         vote = excluded.vote,
         created_at = excluded.created_at`,
      [timelineId, machineId, voteValue, nowSeconds()]
    );

    const counts = await updateTimelineVoteCounts(timelineId);
    return res.json({ ok: true, message: "Timeline vote saved.", timelineId: String(timelineId), ...counts });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Timeline vote failed: " + error.message });
  }
});

app.post("/api/song-timelines/:timelineId/use", async (req, res) => {
  try {
    const timelineId = Math.floor(Number(req.params.timelineId || 0));
    if (!timelineId) {
      return res.status(400).json({ ok: false, message: "Invalid timeline ID." });
    }

    const result = await pool.query(
      `update song_timelines
       set use_count = use_count + 1, updated_at = $2
       where id = $1
       returning use_count`,
      [timelineId, nowSeconds()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Timeline not found." });
    }

    return res.json({
      ok: true,
      message: "Timeline use recorded.",
      timelineId: String(timelineId),
      useCount: Number(result.rows[0].use_count || 0)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Timeline use failed: " + error.message });
  }
});

app.get("/api/admin/timeline-songs", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const songs = await listTimelineSongs(req.query.q || "");
    return res.json({ ok: true, songs });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Timeline songs load failed: " + error.message });
  }
});

app.get("/api/admin/timeline-songs/:songId", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const song = await getTimelineSongDetail(req.params.songId);
    if (!song) {
      return res.status(404).json({ ok: false, message: "Song not found." });
    }

    return res.json({ ok: true, song });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Timeline detail load failed: " + error.message });
  }
});

app.post("/api/admin/delete-timeline", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const deleted = await deleteTimeline(req.body.timelineId);
    if (!deleted) {
      return res.status(404).json({ ok: false, message: "Timeline not found." });
    }

    return res.json({ ok: true, message: "Timeline deleted.", timelineId: String(req.body.timelineId || "") });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Timeline delete failed: " + error.message });
  }
});

app.post("/api/admin/update-timeline-marker", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const body = req.body || {};
    const timeMs = parseAdminMarkerTimeMs(body);
    const marker = await updateTimelineMarker({
      markerId: body.markerId,
      timeMs,
      key: body.key,
      scale: body.scale
    });

    if (!marker) {
      return res.status(400).json({ ok: false, message: "Invalid marker update." });
    }

    return res.json({ ok: true, message: "Timeline marker updated.", marker });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Timeline marker update failed: " + error.message });
  }
});

app.post("/api/admin/approve-timeline-marker", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const marker = await setTimelineMarkerConfirmation(req.body.markerId, "verified");
    if (!marker) {
      return res.status(404).json({ ok: false, message: "Timeline marker not found." });
    }
    return res.json({
      ok: true,
      message: "Marker da duoc admin xac nhan.",
      markerId: marker.markerId,
      timelineId: marker.timelineId,
      status: marker.status
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Marker approval failed: " + error.message });
  }
});

app.post("/api/admin/set-marker-confirmation", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const marker = await setTimelineMarkerConfirmation(req.body.markerId, req.body.status);
    if (!marker) {
      return res.status(404).json({ ok: false, message: "Timeline marker or status not valid." });
    }
    return res.json({ ok: true, message: "Da cap nhat trang thai xac nhan.", ...marker });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Marker confirmation failed: " + error.message });
  }
});

app.post("/api/admin/delete-timeline-song", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const deleted = await deleteTimelineSong(req.body.songId);
    if (!deleted) {
      return res.status(404).json({ ok: false, message: "Song not found." });
    }

    return res.json({ ok: true, message: "Song and timelines deleted.", songId: String(req.body.songId || "") });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Song delete failed: " + error.message });
  }
});

app.post("/api/admin/delete-timeline-songs", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const songIds = [...new Set((Array.isArray(req.body.songIds) ? req.body.songIds : [])
      .map(value => Math.floor(Number(value || 0)))
      .filter(Boolean))]
      .slice(0, 1000);
    if (songIds.length === 0) {
      return res.status(400).json({ ok: false, message: "No valid song IDs selected." });
    }

    const result = await pool.query(
      "delete from songs where id = any($1::bigint[]) returning id",
      [songIds]
    );
    return res.json({
      ok: true,
      message: "Selected songs and timelines deleted.",
      deletedCount: result.rows.length,
      songIds: result.rows.map(row => String(row.id))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Bulk song delete failed: " + error.message });
  }
});

app.get("/api/admin/timeline-backup/export.csv", async (req, res) => {
  try {
    if (!checkTimelineAdminToken(req, res)) return;
    const csv = await buildTimelineBackupCsv();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="pluginlocker-timeline-backup-${date}.csv"`);
    return res.send(csv);
  } catch (error) {
    return res.status(500).json({ ok: false, message: "CSV export failed: " + error.message });
  }
});

app.post(
  "/api/admin/timeline-backup/import",
  express.text({ type: ["text/csv", "text/plain", "application/csv", "application/octet-stream"], limit: "25mb" }),
  async (req, res) => {
    try {
      if (!checkTimelineAdminToken(req, res)) return;
      const result = await importTimelineBackupCsv(req.body);
      return res.json({
        ok: true,
        message: "CSV import thanh cong. Timeline cua cac bai trong file da duoc khoi phuc.",
        imported: result
      });
    } catch (error) {
      return res.status(400).json({ ok: false, message: "CSV import failed: " + error.message });
    }
  }
);

app.get("/admin/timelines", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>PluginLocker Timeline Admin</title>
  <style>
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#0f1115; color:#f5f5f5; }
    header { padding:22px 28px; border-bottom:1px solid #282c35; background:#151820; display:flex; justify-content:space-between; gap:16px; align-items:center; }
    main { padding:24px 28px 40px; max-width:1600px; margin:0 auto; }
    .card { background:#171a22; border:1px solid #2a2f3a; border-radius:14px; padding:16px; margin-bottom:18px; }
    label { display:block; font-size:12px; color:#a8b0c0; margin:10px 0 6px; }
    input { width:100%; box-sizing:border-box; border:1px solid #333a48; border-radius:10px; padding:10px 12px; background:#0f1117; color:#fff; }
    input[type="checkbox"] { width:18px; height:18px; padding:0; accent-color:#3b82f6; cursor:pointer; }
    select { box-sizing:border-box; border:1px solid #333a48; border-radius:10px; padding:9px 34px 9px 12px; background:#0f1117; color:#fff; }
    button { border:0; border-radius:10px; padding:9px 12px; background:#3b82f6; color:white; cursor:pointer; font-weight:650; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    button.secondary { background:#374151; }
    button.danger { background:#dc2626; }
    .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .row > * { flex:1; min-width:180px; }
    .toolbar { display:flex; gap:10px; align-items:center; justify-content:space-between; margin-bottom:12px; }
    .muted { color:#8b94a7; font-size:12px; }
    .pill { display:inline-block; border-radius:999px; padding:3px 8px; font-size:12px; font-weight:700; background:rgba(59,130,246,.18); color:#93c5fd; }
    .song-table-wrap { overflow:auto; max-height:720px; border-radius:8px; }
    table { width:100%; min-width:1120px; border-collapse:separate; border-spacing:0; table-layout:fixed; }
    th,td { padding:12px 10px; border-bottom:1px solid #292f3a; text-align:left; vertical-align:top; font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
    th { color:#a8b0c0; background:#11141b; position:sticky; top:0; z-index:1; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .summary-lines { display:grid; gap:6px; }
    .summary-line { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .summary-key { font-weight:750; color:#f8fafc; }
    .summary-meta { color:#93c5fd; font-weight:750; }
    .stat-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:12px 0; }
    .stat { border:1px solid #2a2f3a; border-radius:10px; padding:10px; background:#11141b; }
    .stat b { display:block; font-size:18px; margin-top:4px; }
    pre { white-space:pre-wrap; word-break:break-word; background:#0f1117; border:1px solid #2a2f3a; border-radius:10px; padding:10px; min-height:44px; max-height:300px; overflow:auto; color:#cbd5e1; }
    .detail-grid { display:grid; grid-template-columns:minmax(420px,1fr) minmax(420px,1fr); gap:14px; align-items:start; }
    .timeline-list { max-height:min(620px,60vh); overflow-y:auto; padding-right:6px; scrollbar-gutter:stable; }
    .panel-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .panel-toggle { min-width:72px; padding:7px 11px; }
    .inline-check { display:flex; align-items:center; gap:8px; margin:0; color:#cbd5e1; cursor:pointer; white-space:nowrap; }
    .inline-check input { flex:0 0 auto; }
    .youtube-id { display:none; }
    #songTable .youtube-column { width:120px; }
    #songTable.show-youtube-id .youtube-column { width:220px; }
    #songTable.show-youtube-id .youtube-id { display:inline; }
    [hidden] { display:none !important; }
    @media (max-width: 980px) { .detail-grid { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <header><div><h1 style="margin:0">PluginLocker Timeline Admin</h1><div class="muted">Server rieng cho bai YouTube, timeline va moc len tone.</div></div></header>
  <main>
    <section class="card"><div class="row">
      <div><label>Timeline admin token</label><input id="adminToken" type="password" placeholder="Nhap timeline admin token" autocomplete="off" /></div>
      <div><label>Tim bai / YouTube ID</label><input id="searchBox" placeholder="VD: _P-qjzEz_Hs hoac ten bai" /></div>
      <div style="flex:0 0 auto; align-self:end"><button id="loadBtn" type="button">Tai danh sach</button></div>
      <div style="flex:0 0 auto; align-self:end"><button id="saveTokenBtn" class="secondary" type="button">Luu token</button></div>
    </div><div id="summaryText" class="muted" style="margin-top:12px">Chua tai du lieu.</div></section>
    <section class="card"><div class="toolbar"><h2 style="margin:0">Bai da upload</h2><span class="pill" id="songCount">0 bai</span></div>
      <div class="row" style="margin-bottom:12px">
        <div><label style="margin-top:0">Loc theo ten bai</label><select id="titleFilter"><option value="all">Tat ca bai</option><option value="karaoke">Co Beat hoac Karaoke</option><option value="non-karaoke">Khong co Beat/Karaoke</option><option value="pending-modulation">Cho duyet len tone</option><option value="pending-low-confidence">Cho duyet conf thap</option></select></div>
        <div style="flex:0 0 auto;min-width:0;align-self:end;padding-bottom:8px"><label class="inline-check"><input id="showYoutubeId" type="checkbox" /><span>Hiện ID YouTube</span></label></div>
        <div style="flex:0 0 auto;min-width:0;align-self:end"><button id="deleteSelectedSongsBtn" class="danger" type="button" disabled>Xoa cac bai da chon</button></div>
        <div id="selectionSummary" class="muted" style="flex:0 0 auto;min-width:120px;align-self:end;padding-bottom:9px">Da chon 0 bai</div>
      </div>
      <div class="song-table-wrap"><table id="songTable"><thead><tr><th style="width:44px;text-align:center"><input id="selectAllSongs" type="checkbox" title="Chon tat ca ket qua dang hien thi" /></th><th class="youtube-column">YouTube</th><th style="width:260px">Ten bai</th><th style="width:110px">Thoi luong</th><th>Ket qua tong hop</th><th style="width:180px">Cap nhat</th><th style="width:220px">Thao tac</th></tr></thead><tbody id="songRows"></tbody></table></div>
    </section>
    <section class="detail-grid"><div class="card"><h2 style="margin-top:0">Chi tiet timeline</h2><div id="detailBox" class="muted">Chon mot bai de xem timeline.</div></div><div class="card"><div class="panel-heading"><h2 style="margin:0">Kết quả API</h2><button id="apiResultToggle" class="secondary panel-toggle" type="button" aria-expanded="false" aria-controls="apiResultContent">Mở</button></div><div id="apiResultContent" hidden><pre id="resultBox">Chua co thao tac.</pre></div></div></section>
    <section class="card">
      <div class="toolbar"><div><h2 style="margin:0 0 4px">Sao luu / chuyen server</h2><div class="muted">Xuat CSV de backup. Khi nhap, timeline cua cac bai co trong file se duoc khoi phuc va thay the du lieu cu cua chinh cac bai do.</div></div></div>
      <div class="row">
        <div style="flex:0 0 auto;min-width:0"><button id="exportCsvBtn" type="button">Xuat file CSV</button></div>
        <div><input id="importCsvFile" type="file" accept=".csv,text/csv" /></div>
        <div style="flex:0 0 auto;min-width:0"><button id="importCsvBtn" class="secondary" type="button">Nhap file CSV</button></div>
      </div>
      <div id="backupStatus" class="muted" style="margin-top:10px">Chua co thao tac backup.</div>
    </section>
  </main>
  <script>
    let songs = []; let selectedSong = null; let editingMarkerId = ""; const selectedSongIds = new Set(); const lowConfidenceReviewThreshold = 0.25; const $ = id => document.getElementById(id);
    function getToken(){ return $("adminToken").value.trim(); }
    function restoreToken(){ const params=new URLSearchParams(window.location.search); const urlToken=params.get("adminToken")||""; const storedToken=localStorage.getItem("pluginlockerTimelineAdminToken")||""; $("adminToken").value=urlToken||storedToken; if(urlToken){ localStorage.setItem("pluginlockerTimelineAdminToken",urlToken); window.history.replaceState({},document.title,window.location.pathname); } }
    function saveToken(){ localStorage.setItem("pluginlockerTimelineAdminToken", getToken()); showResult({ok:true,message:"Da luu timeline token trong trinh duyet nay."}); }
    function showResult(obj){ $("resultBox").textContent = typeof obj === "string" ? obj : JSON.stringify(obj,null,2); }
    function setApiResultExpanded(expanded){ $("apiResultContent").hidden=!expanded; $("apiResultToggle").setAttribute("aria-expanded",String(expanded)); $("apiResultToggle").textContent=expanded?"Đóng":"Mở"; }
    function toggleApiResult(){ setApiResultExpanded($("apiResultToggle").getAttribute("aria-expanded")!=="true"); }
    function restoreYoutubeIdVisibility(){ const visible=localStorage.getItem("pluginlockerShowYoutubeId")==="true"; $("showYoutubeId").checked=visible; $("songTable").classList.toggle("show-youtube-id",visible); }
    function setYoutubeIdVisibility(visible){ localStorage.setItem("pluginlockerShowYoutubeId",String(visible)); $("songTable").classList.toggle("show-youtube-id",visible); }
    function escapeText(value){ return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
    function formatDate(seconds){ if(!seconds)return "-"; return new Date(seconds*1000).toLocaleString(); }
    function formatTime(seconds){ seconds=Math.max(0,Math.floor(Number(seconds)||0)); const m=Math.floor(seconds/60); const s=seconds%60; return m+":"+String(s).padStart(2,"0"); }
    function pickBestAggregateMarkers(markers){ markers=Array.isArray(markers)?markers:[]; const byAccuracy=(a,b)=>(Number(b.confidence)||0)-(Number(a.confidence)||0)||(Number(b.supportCount)||0)-(Number(a.supportCount)||0)||(Number(a.timeMs)||0)-(Number(b.timeMs)||0); const bestInitial=markers.filter(marker=>marker.markerType==="initial_key").sort(byAccuracy)[0]; const bestModulation=markers.filter(marker=>marker.markerType!=="initial_key").sort(byAccuracy)[0]; return [bestInitial,bestModulation].filter(Boolean); }
    function renderAggregateMarkers(markers, compact=false){ markers=compact?pickBestAggregateMarkers(markers):(Array.isArray(markers)?markers:[]); if(!markers.length) return '<span class="muted">Chua co ket qua tong hop</span>'; return '<div class="summary-lines">'+markers.slice(0,compact?2:4).map(marker=>{ const percent=Math.round(Math.max(0,Math.min(1,Number(marker.confidence)||0))*100); const label=marker.markerType==="initial_key"?"Dau bai":"Len tone"; return '<div class="summary-line"><span class="pill">'+escapeText(label)+'</span><span class="summary-key">'+escapeText(marker.key)+' '+escapeText(marker.scale)+'</span><span class="summary-meta">'+percent+'%</span><span class="muted">@ '+escapeText(formatTime((marker.timeMs||0)/1000))+'</span><span class="muted">support '+escapeText(marker.supportCount||0)+'</span></div>'; }).join("")+'</div>'; }
    function renderPendingModulationBadge(song){ const count=Number(song?.pendingModulationCount||0); if(count<=0) return ""; return '<div class="summary-line" style="margin-top:6px"><span class="pill" style="background:rgba(234,179,8,.18);color:#fde68a">Cho duyet len tone '+escapeText(count)+'</span></div>'; }
    function renderPendingLowConfidenceBadge(song){ const count=Number(song?.pendingLowConfidenceCount||0); if(count<=0) return ""; return '<div class="summary-line" style="margin-top:6px"><span class="pill" style="background:rgba(234,179,8,.18);color:#fde68a">Cho duyet conf thap '+escapeText(count)+'</span></div>'; }
    async function api(path, body){ const res=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); const text=await res.text(); let data; try{data=JSON.parse(text)}catch{data={ok:false,message:text}} if(!res.ok) throw data; return data; }
    async function loadSongs(){ try{ const q=encodeURIComponent($("searchBox").value.trim()); const res=await fetch("/api/admin/timeline-songs?adminToken="+encodeURIComponent(getToken())+"&q="+q); const data=await res.json(); if(!res.ok) throw data; songs=data.songs||[]; selectedSongIds.clear(); showResult(data); renderSongs(); }catch(e){ showResult(e); } }
    async function showSong(songId){ try{ const res=await fetch("/api/admin/timeline-songs/"+encodeURIComponent(songId)+"?adminToken="+encodeURIComponent(getToken())); const data=await res.json(); if(!res.ok) throw data; selectedSong=data.song; showResult(data); renderDetail(data.song); }catch(e){ showResult(e); } }
    async function editSongAggregate(songId,markerType,timeMs,key,scale){ try{ const res=await fetch("/api/admin/timeline-songs/"+encodeURIComponent(songId)+"?adminToken="+encodeURIComponent(getToken())); const data=await res.json(); if(!res.ok) throw data; selectedSong=data.song; const marker=findAggregateSourceMarker(selectedSong,{markerType,timeMs,key,scale}); if(!marker){ showResult({ok:false,message:"Khong tim thay marker goc de edit ket qua tong hop."}); renderDetail(selectedSong); return; } editingMarkerId=String(marker.markerId||""); showResult(data); renderDetail(selectedSong); }catch(e){ showResult(e); } }
    function findAggregateSourceMarker(song,aggregate){ const markers=[]; for(const timeline of (song?.timelines||[])){ for(const marker of (timeline.markers||[])){ markers.push(marker); } } const wantedType=String(aggregate.markerType||""); const wantedKey=String(aggregate.key||"").toUpperCase(); const wantedScale=String(aggregate.scale||"").toUpperCase(); const wantedTime=Number(aggregate.timeMs)||0; return markers.filter(marker=>String(marker.markerType||"")===wantedType&&String(marker.key||"").toUpperCase()===wantedKey&&String(marker.scale||"").toUpperCase()===wantedScale).sort((a,b)=>Math.abs((Number(a.timeMs)||0)-wantedTime)-Math.abs((Number(b.timeMs)||0)-wantedTime))[0]||null; }
    async function deleteTimeline(timelineId){ if(!confirm("Xoa timeline #"+timelineId+"?")) return; try{ const data=await api("/api/admin/delete-timeline",{adminToken:getToken(),timelineId}); showResult(data); if(selectedSong) await showSong(selectedSong.songId); await loadSongs(); }catch(e){ showResult(e); } }
    async function deleteSong(songId){ const song=songs.find(item=>item.songId===String(songId)); if(!confirm("Xoa ca bai nay va tat ca timeline?\\n\\n"+(song?.title||song?.youtubeVideoId||songId))) return; try{ const data=await api("/api/admin/delete-timeline-song",{adminToken:getToken(),songId}); showResult(data); selectedSong=null; $("detailBox").innerHTML='<span class="muted">Chon mot bai de xem timeline.</span>'; await loadSongs(); }catch(e){ showResult(e); } }
    function isKaraokeTitle(song){ const title=String(song?.title||"").toLocaleLowerCase(); return title.includes("beat")||title.includes("karaoke"); }
    function getFilteredSongs(){ const filter=$("titleFilter").value; if(filter==="karaoke") return songs.filter(isKaraokeTitle); if(filter==="non-karaoke") return songs.filter(song=>!isKaraokeTitle(song)); if(filter==="pending-modulation") return songs.filter(song=>Number(song.pendingModulationCount||0)>0); if(filter==="pending-low-confidence") return songs.filter(song=>Number(song.pendingLowConfidenceCount||0)>0); return songs; }
    function updateSelectionUi(){ const visible=getFilteredSongs(); const selectedVisible=visible.filter(song=>selectedSongIds.has(String(song.songId))).length; const all=$("selectAllSongs"); all.checked=visible.length>0&&selectedVisible===visible.length; all.indeterminate=selectedVisible>0&&selectedVisible<visible.length; $("selectionSummary").textContent="Da chon "+selectedSongIds.size+" bai"; $("deleteSelectedSongsBtn").disabled=selectedSongIds.size===0; }
    function toggleSongSelection(songId,checked){ if(checked) selectedSongIds.add(String(songId)); else selectedSongIds.delete(String(songId)); updateSelectionUi(); }
    function toggleSelectAllFiltered(checked){ for(const song of getFilteredSongs()){ if(checked) selectedSongIds.add(String(song.songId)); else selectedSongIds.delete(String(song.songId)); } renderSongs(); }
    function applyTitleFilter(){ selectedSongIds.clear(); renderSongs(); }
    async function deleteSelectedSongs(){ const ids=[...selectedSongIds]; if(!ids.length) return; if(!confirm("Xoa vinh vien "+ids.length+" bai da chon va toan bo timeline/hop am lien quan?")) return; try{ const data=await api("/api/admin/delete-timeline-songs",{adminToken:getToken(),songIds:ids}); showResult(data); if(selectedSong&&ids.includes(String(selectedSong.songId))){ selectedSong=null; $("detailBox").innerHTML='<span class="muted">Chon mot bai de xem timeline.</span>'; } await loadSongs(); }catch(e){ showResult(e); } }
    function renderAggregateEditButtons(song){ const id=String(song.songId); return pickBestAggregateMarkers(song.aggregateMarkers).map(marker=>{ const label=marker.markerType==="initial_key"?"Edit dau":"Edit len"; return '<button class="secondary" onclick="editSongAggregate(\\''+escapeText(id)+'\\',\\''+escapeText(marker.markerType)+'\\','+escapeText(Number(marker.timeMs)||0)+',\\''+escapeText(marker.key)+'\\',\\''+escapeText(marker.scale)+'\\')">'+escapeText(label)+'</button>'; }).join(""); }
    function renderSongs(){ const visible=getFilteredSongs(); $("songCount").textContent=visible.length+" / "+songs.length+" bai"; $("summaryText").textContent="Dang hien thi "+visible.length+" tren "+songs.length+" bai."; $("songRows").innerHTML=visible.map(song=>{ const id=String(song.songId); const title=song.title||"(chua co ten)"; const youtubeUrl="https://www.youtube.com/watch?v="+encodeURIComponent(song.youtubeVideoId); const checked=selectedSongIds.has(id)?" checked":""; return '<tr><td style="text-align:center"><input type="checkbox"'+checked+' onchange="toggleSongSelection(\\''+escapeText(id)+'\\',this.checked)" /></td><td><b class="youtube-id">'+escapeText(song.youtubeVideoId)+'</b><div><a href="'+youtubeUrl+'" target="_blank">Mo YouTube</a></div></td><td>'+escapeText(title)+'<div class="muted">'+escapeText(song.artist||"")+'</div></td><td>'+escapeText(formatTime(song.durationSeconds))+'</td><td>'+renderAggregateMarkers(song.aggregateMarkers,true)+renderPendingModulationBadge(song)+renderPendingLowConfidenceBadge(song)+'</td><td>'+escapeText(formatDate(song.lastTimelineAt||song.updatedAt))+'</td><td class="actions"><button class="secondary" onclick="showSong(\\''+escapeText(id)+'\\')">Chi tiet</button><button class="danger" onclick="deleteSong(\\''+escapeText(id)+'\\')">Xoa bai</button>'+renderAggregateEditButtons(song)+'</td></tr>'; }).join(""); updateSelectionUi(); }
    async function setMarkerConfirmation(markerId,status){ const label=status==="verified"?"duyet":status==="rejected"?"tu choi/thu hoi":"dua ve cho"; if(!confirm("Admin "+label+" moc timeline nay?")) return; try{ const data=await api("/api/admin/set-marker-confirmation",{adminToken:getToken(),markerId,status}); showResult(data); if(selectedSong) await showSong(selectedSong.songId); await loadSongs(); }catch(e){ showResult(e); } }
    function editMarker(markerId){ editingMarkerId=String(markerId||""); if(selectedSong) renderDetail(selectedSong); }
    function cancelEditMarker(){ editingMarkerId=""; if(selectedSong) renderDetail(selectedSong); }
    async function saveMarker(markerId){ const id=String(markerId||""); try{ const data=await api("/api/admin/update-timeline-marker",{adminToken:getToken(),markerId:id,timeText:$("markerTime-"+id).value,key:$("markerKey-"+id).value,scale:$("markerScale-"+id).value}); showResult(data); editingMarkerId=""; if(selectedSong) await showSong(selectedSong.songId); await loadSongs(); }catch(e){ showResult(e); } }
    function renderMarkerRow(marker,status){ const markerId=String(marker.markerId||""); if(editingMarkerId===markerId){ return '<tr><td><input id="markerTime-'+escapeText(markerId)+'" value="'+escapeText(formatTime(marker.timeMs/1000))+'" /></td><td><input id="markerKey-'+escapeText(markerId)+'" value="'+escapeText(marker.key)+'" /></td><td><input id="markerScale-'+escapeText(markerId)+'" value="'+escapeText(marker.scale)+'" /></td><td>'+escapeText(marker.markerType)+'</td><td>'+escapeText(marker.confidence)+'</td><td class="actions">'+status+' <button onclick="saveMarker(\\''+escapeText(markerId)+'\\')">Luu</button> <button class="secondary" onclick="cancelEditMarker()">Huy</button></td></tr>'; } return '<tr><td>'+escapeText(formatTime(marker.timeMs/1000))+'</td><td>'+escapeText(marker.key)+'</td><td>'+escapeText(marker.scale)+'</td><td>'+escapeText(marker.markerType)+'</td><td>'+escapeText(marker.confidence)+'</td><td class="actions">'+status+' <button class="secondary" onclick="editMarker(\\''+escapeText(markerId)+'\\')">Edit</button></td></tr>'; }
    function renderDetail(song){
      const timelines=song.timelines||[];
      const stats='<div class="stat-grid"><div class="stat"><span class="muted">Timeline</span><b>'+escapeText(song.timelineCount||0)+'</b></div><div class="stat"><span class="muted">Moc</span><b>'+escapeText(song.markerCount||0)+'</b></div><div class="stat"><span class="muted">Luot dung</span><b>'+escapeText(song.useCount||0)+'</b></div></div>';
      const aggregate='<div style="border:1px solid #2a2f3a;border-radius:12px;padding:12px;margin:12px 0"><div style="font-weight:750;margin-bottom:8px">Ket qua tong hop</div>'+renderAggregateMarkers(song.aggregateMarkers)+'</div>';
      const timelineHtml=timelines.map(timeline=>{
        const markers=timeline.markers||[];
        const markerRows=markers.map(marker=>{
          const isInitial=marker.markerType==="initial_key";
          const isLowConfidence=(Number(marker.confidence)||0)<lowConfidenceReviewThreshold;
          const support=Math.min(3,Number(marker.confirmationSupportCount)||0);
          let status;
          if(isInitial){
            if(marker.adminApproved){
              status='<span class="pill" style="background:rgba(34,197,94,.18);color:#86efac">Admin da duyet</span> <button class="danger" onclick="setMarkerConfirmation(\\''+escapeText(marker.markerId)+'\\',\\'rejected\\')">Thu hoi</button>';
            }else if(marker.confirmationStatus==="rejected"){
              status='<span class="pill" style="background:rgba(220,38,38,.18);color:#fca5a5">Da tu choi</span> <button class="secondary" onclick="setMarkerConfirmation(\\''+escapeText(marker.markerId)+'\\',\\'verified\\')">Admin duyet</button>';
            }else if(isLowConfidence){
              status='<span class="pill">Dau bai</span> <span class="muted">Cho duyet conf thap</span> <button class="secondary" onclick="setMarkerConfirmation(\\''+escapeText(marker.markerId)+'\\',\\'verified\\')">Admin duyet</button> <button class="danger" onclick="setMarkerConfirmation(\\''+escapeText(marker.markerId)+'\\',\\'rejected\\')">Tu choi</button>';
            }else{
              status='<span class="pill">Dau bai</span>';
            }
          }else if(marker.confirmationStatus==="verified"){
            const verifiedLabel=marker.adminApproved?'Admin da duyet':'Da xac nhan '+support+'/3 may';
            status='<span class="pill" style="background:rgba(34,197,94,.18);color:#86efac">'+verifiedLabel+'</span> <button class="danger" onclick="setMarkerConfirmation(\\''+escapeText(marker.markerId)+'\\',\\'rejected\\')">Thu hoi</button>';
          }else if(marker.confirmationStatus==="rejected"){
            status='<span class="pill" style="background:rgba(220,38,38,.18);color:#fca5a5">Da tu choi</span> <button class="secondary" onclick="setMarkerConfirmation(\\''+escapeText(marker.markerId)+'\\',\\'verified\\')">Admin duyet</button>';
          }else{
            const pendingLabel=isLowConfidence?'Cho duyet conf thap':'Cho xac nhan '+support+'/3 may';
            status='<span class="muted">'+pendingLabel+'</span> <button class="secondary" onclick="setMarkerConfirmation(\\''+escapeText(marker.markerId)+'\\',\\'verified\\')">Admin duyet</button> <button class="danger" onclick="setMarkerConfirmation(\\''+escapeText(marker.markerId)+'\\',\\'rejected\\')">Tu choi</button>';
          }
          return renderMarkerRow(marker,status);
        }).join("");
        return '<div style="border:1px solid #2a2f3a;border-radius:12px;padding:12px;margin-bottom:12px"><div class="row"><div><b>Timeline #'+escapeText(timeline.timelineId)+'</b><div class="muted">source: '+escapeText(timeline.source||"-")+' | machine: '+escapeText(timeline.createdByMachineId||"-")+'</div></div><div><span class="pill">up '+escapeText(timeline.voteUp)+'</span> <span class="pill">down '+escapeText(timeline.voteDown)+'</span> <span class="pill">use '+escapeText(timeline.useCount)+'</span></div><div style="flex:0 0 auto"><button class="danger" onclick="deleteTimeline(\\''+escapeText(timeline.timelineId)+'\\')">Xoa timeline</button></div></div><div class="muted" style="margin:8px 0">updated: '+escapeText(formatDate(timeline.updatedAt))+'</div><table style="min-width:0"><thead><tr><th>Time</th><th>Key</th><th>Scale</th><th>Type</th><th>Confidence</th><th>Xac nhan</th></tr></thead><tbody>'+markerRows+'</tbody></table></div>';
      }).join("");
      $("detailBox").innerHTML='<div><b>'+escapeText(song.title||song.youtubeVideoId)+'</b></div><div class="muted">YouTube ID: '+escapeText(song.youtubeVideoId)+' | '+escapeText(formatTime(song.durationSeconds))+'</div>'+stats+aggregate+'<div class="timeline-list" style="margin-top:12px">'+timelineHtml+'</div>';
    }
    async function exportCsv(){ try{ $("backupStatus").textContent="Dang tao file CSV..."; const res=await fetch("/api/admin/timeline-backup/export.csv?adminToken="+encodeURIComponent(getToken())); if(!res.ok){ const error=await res.json(); throw error; } const blob=await res.blob(); const url=URL.createObjectURL(blob); const link=document.createElement("a"); link.href=url; link.download="pluginlocker-timeline-backup-"+new Date().toISOString().slice(0,10)+".csv"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); $("backupStatus").textContent="Da xuat file CSV thanh cong."; }catch(e){ $("backupStatus").textContent=e.message||"Xuat CSV that bai."; showResult(e); } }
    async function importCsv(){ const file=$("importCsvFile").files[0]; if(!file){ $("backupStatus").textContent="Hay chon file CSV can nhap."; return; } if(!confirm("Nhap backup nay? Timeline hien tai cua cac bai co trong file se bi thay the.")) return; try{ $("backupStatus").textContent="Dang nhap va khoi phuc CSV..."; const csv=await file.text(); const res=await fetch("/api/admin/timeline-backup/import?adminToken="+encodeURIComponent(getToken()),{method:"POST",headers:{"Content-Type":"text/csv; charset=utf-8"},body:csv}); const data=await res.json(); if(!res.ok) throw data; $("backupStatus").textContent="Nhap thanh cong: "+data.imported.songs+" bai, "+data.imported.timelines+" timeline, "+data.imported.markers+" moc."; showResult(data); selectedSong=null; $("detailBox").innerHTML='<span class="muted">Chon mot bai de xem timeline.</span>'; await loadSongs(); }catch(e){ $("backupStatus").textContent=e.message||"Nhap CSV that bai."; showResult(e); } }
    restoreToken(); restoreYoutubeIdVisibility(); setApiResultExpanded(false); $("saveTokenBtn").addEventListener("click", saveToken); $("loadBtn").addEventListener("click", loadSongs); $("exportCsvBtn").addEventListener("click", exportCsv); $("importCsvBtn").addEventListener("click", importCsv); $("titleFilter").addEventListener("change", applyTitleFilter); $("showYoutubeId").addEventListener("change", event=>setYoutubeIdVisibility(event.target.checked)); $("apiResultToggle").addEventListener("click", toggleApiResult); $("selectAllSongs").addEventListener("change", event=>toggleSelectAllFiltered(event.target.checked)); $("deleteSelectedSongsBtn").addEventListener("click", deleteSelectedSongs); $("searchBox").addEventListener("keydown", event => { if(event.key === "Enter") loadSongs(); }); loadSongs();
  </script>
</body>
</html>`);
});

ensureSchema()
  .then(() => {
    schemaReady = true;
    console.log("Timeline schema ready.");
  })
  .catch(error => {
    schemaReady = false;
    schemaErrorMessage = error.message;
    console.error("Failed to initialize timeline schema:", error);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`PluginLocker timeline server running on port ${PORT}`);
    });
  });
