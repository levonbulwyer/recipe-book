PRAGMA foreign_keys = ON;

-- Master ingredient list: every recipe line points here, so names stay clean.
CREATE TABLE ingredient (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  aliases       TEXT NOT NULL DEFAULT '',          -- comma separated, used by the import review
  aisle         TEXT,
  default_unit  TEXT CHECK (default_unit IN ('g','mL','tsp','tbsp','each','pinch')),
  density_g_ml  REAL,                              -- for converting volume to grams, approximate
  is_staple     INTEGER NOT NULL DEFAULT 0 CHECK (is_staple IN (0,1)),
  notes         TEXT
);

CREATE TABLE recipe (
  id             INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  source         TEXT,                             -- book, website or "Own recipe"
  page           TEXT,
  cuisine        TEXT,
  type           TEXT,                             -- dinner, baking, breakfast ...
  base_servings  INTEGER NOT NULL CHECK (base_servings > 0),
  prep_min       INTEGER,
  cook_min       INTEGER,
  notes          TEXT
);

CREATE TABLE recipe_label (
  recipe_id INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  label     TEXT NOT NULL,
  PRIMARY KEY (recipe_id, label)
);

-- One line of a recipe. amount is in the stored unit, metric only.
CREATE TABLE recipe_ingredient (
  id             INTEGER PRIMARY KEY,
  recipe_id      INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,                    -- short handle used by steps, unique per recipe
  ingredient_id  INTEGER NOT NULL REFERENCES ingredient(id),
  display_name   TEXT,                             -- wording as written, e.g. "shiitake or portobello mushrooms"
  amount         REAL,                             -- NULL means "to taste" or unmeasured
  unit           TEXT CHECK (unit IN ('g','mL','tsp','tbsp','each','pinch')),
  noun           TEXT,                             -- "cloves", "stalk" for counted items
  scaling        TEXT NOT NULL DEFAULT 'linear' CHECK (scaling IN ('linear','fixed')),
  estimated      INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0,1)),  -- converted from cups via density
  note           TEXT,                             -- prep or alternative, e.g. "or 1 x 400 g can"
  position       INTEGER NOT NULL,
  UNIQUE (recipe_id, key)
);

CREATE TABLE step (
  id          INTEGER PRIMARY KEY,
  recipe_id   INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  position    INTEGER NOT NULL,
  body        TEXT NOT NULL,
  timer_text  TEXT,
  continues   INTEGER NOT NULL DEFAULT 0 CHECK (continues IN (0,1)),  -- stacks under its first "from" step
  UNIQUE (recipe_id, key),
  UNIQUE (recipe_id, position)
);

-- Ingredients a step uses directly (drives the left-hand rows of the grid).
CREATE TABLE step_uses (
  step_id              INTEGER NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  recipe_ingredient_id INTEGER NOT NULL REFERENCES recipe_ingredient(id) ON DELETE CASCADE,
  PRIMARY KEY (step_id, recipe_ingredient_id)
);

-- Earlier steps a step combines (drives the columns and spans of the grid).
CREATE TABLE step_from (
  step_id      INTEGER NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  from_step_id INTEGER NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  PRIMARY KEY (step_id, from_step_id),
  CHECK (step_id <> from_step_id)
);

CREATE INDEX idx_ri_recipe ON recipe_ingredient(recipe_id);
CREATE INDEX idx_ri_ing    ON recipe_ingredient(ingredient_id);
CREATE INDEX idx_step_recipe ON step(recipe_id);

CREATE VIEW v_recipe_library AS
SELECT r.id, r.title, r.source, r.page, r.cuisine, r.type,
       r.prep_min, r.cook_min,
       COALESCE(r.prep_min,0) + COALESCE(r.cook_min,0) AS total_min,
       CASE WHEN COALESCE(r.prep_min,0)+COALESCE(r.cook_min,0) <= 30 THEN 'Quick'
            WHEN COALESCE(r.prep_min,0)+COALESCE(r.cook_min,0) <= 60 THEN 'Medium'
            ELSE 'Long' END AS time_band,
       (SELECT group_concat(label, ', ') FROM recipe_label l WHERE l.recipe_id = r.id) AS labels
FROM recipe r;

-- Ingredients that appear in recipes, for the shopping list to read.
CREATE VIEW v_recipe_shopping AS
SELECT ri.recipe_id, i.name, i.aisle, ri.amount, ri.unit, ri.scaling, ri.estimated
FROM recipe_ingredient ri JOIN ingredient i ON i.id = ri.ingredient_id;

-- When a recipe was cooked, with a rating and notes.
CREATE TABLE IF NOT EXISTS cook_log (
  id         INTEGER PRIMARY KEY,
  recipe_id  INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  cooked_on  TEXT NOT NULL,                       -- YYYY-MM-DD
  servings   INTEGER,
  rating     INTEGER CHECK (rating BETWEEN 1 AND 5),
  notes      TEXT
);
