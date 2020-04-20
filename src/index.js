const s = require('slonik');
const glob = require('glob');
const fs = require('fs');

function migrationLocationToMigration(loc) {
  const pluginName = loc.slice(loc.lastIndexOf('/') + 1, loc.lastIndexOf('.'));
  return {
    order: parseInt(pluginName),
    location: loc,
    name: pluginName
  }
}

async function findMigrationsIn(dir_prefix) {
  //console.log(`Looking for migrations in ${dir_prefix}`)
  return new Promise((resolve, reject) =>
    glob(dir_prefix + '/*.js', {}, (er, files) => {
      if (er) {
        reject(er);
      } else {
        resolve(files.map(migrationLocationToMigration));
      }
    })
  );
}

async function hasBeenRun(con, migration) {
  return await con.oneFirst(s.sql`select count (*) from migrations where name=${migration.name}`) != 0;
}

async function _applyMigration(pool, migration) {
  await pool.transaction(async con => {
    console.log(`Running migration ${migration.name}`);
    
    const migration_code = require(migration.location);
    await migration_code.up(con);
    await con.query(s.sql`
      insert into migrations (name) values (${migration.name})
    `);
  });
  return true;
}

exports.applyMigration = async function(connection_string, migration_loc) {
  if (!fs.existsSync(migration_loc)) {
    console.log(`Run aborted. ${migration_loc} not found`);
    return;
  }

  const m = migrationLocationToMigration(migration_loc);

  const pool = getDb(connection_string);
  if (!await hasBeenRun(pool, m)) {
    await _applyMigration(pool, m);
  } else {
    console.log(`Run aborted. ${migration_loc} has already been applied`);
  }
  await pool.end();
}

exports.revertMigration = async function(connection_string, migration_loc) {
  if (!fs.existsSync(migration_loc)) {
    console.log(`Revert aborted. ${migration_loc} not found`);
    return;
  }

  const m = migrationLocationToMigration(migration_loc);

  const pool = getDb(connection_string);
  if (!await hasBeenRun(pool, m)) {
    console.log(`Revert aborted because no migration with name=${m.name} found in migrations table`);
    await pool.end();
    return;
  }

  await pool.transaction(async con => {
    console.log(`Reverting migration ${m.location}`);
    
    const migration_code = require(m.location);
    await migration_code.down(con);
    await con.query(s.sql`
      delete from migrations where name=${m.name}
    `);
  });
  await pool.end();
}

function getDb(connection_string) {
  return s.createPool(connection_string);
}

async function findAllMigrations(paths) {
  let migrations = [];
  for (const p of paths) {
    migrations = migrations.concat(await findMigrationsIn(p));
  }

  // sort oldest to newest
  migrations.sort((a, b) => a.order - b.order);
  return migrations;
}

async function createMigrationTable(pool) {
  return pool.query(s.sql`
    create table if not exists migrations (
      name text not null unique,
      timestamp timestamptz not null default now()
    )
  `);
}

exports.applyAllMigrations = async function(connection_string, paths) {
  const pool = getDb(connection_string);
  await createMigrationTable(pool);
  const migrations = await findAllMigrations(paths);

  let num_run = 0;
  for (const m of migrations) {
    if (!await hasBeenRun(pool, m)) {
      if (await _applyMigration(pool, m)) num_run++;
    }
  }

  if (num_run) {
    console.log(`Applied ${num_run} migrations`);
  } else {
    console.log(`No new migrations to apply`);
  }
  await pool.end();
}

exports.createMigration = function(name, directory) {
  const timestamp = Date.now();
  const filename = `${directory}/${timestamp}-${name}.js`;
  fs.writeFileSync(filename,
`const sql = require('slonik').sql;

exports.up = async function(con) {
  await con.query(sql\`
  \`);
};

exports.down = async function(con) {
  await con.query(sql\`
  \`);
};`);
  console.log(`Migration written to ${filename}`);
}

async function listMigrations(connection_string, migration_paths) {
  const pool = await getDb(connection_string);
  await createMigrationTable(pool);
  const migrations = await findAllMigrations(migration_paths);
  console.log("Applied Y/N     Path to migration");
  for (m of migrations) {
    const run = await hasBeenRun(pool, m);
    console.log(`${run ? 'Y' : 'N'}               ${m.location}`);
  }
  console.log('');
  await pool.end();
}

exports.cmd = async function(cmd_name, connection_string, migration_paths) {
  const [,, ...args] = process.argv;

  if (args[0] == 'all') {
    exports.applyAllMigrations(connection_string, migration_paths);

  } else if (args[0] == 'list') {
    await listMigrations(connection_string, migration_paths);
  } else if (args[0] == 'revert') {
    const migration_loc = args[1];
    if (migration_loc) {
      exports.revertMigration(connection_string, migration_loc);
    } else {
      console.log("Path to migration file expected as argument to revert");
    }

  } else if (args[0] == 'apply') {
    const migration_loc = args[1];
    if (migration_loc) {
      exports.applyMigration(connection_string, migration_loc);
    } else {
      console.log("Path to migration file expected as argument to apply");
    }

  } else if (args[0] == 'create') {
    if (!args[1] || !args[2]) {
      console.log("Expected arguments <name> <directory>");
    } else {
      exports.createMigration(args[1], args[2]);
    }

  } else {
    console.log(`Usage:
${cmd_name} all                               # Apply all pending migrations
${cmd_name} list                              # Show all migrations, oldest to newest
${cmd_name} apply  ./path/to/the/migration.js # Apply one migration
${cmd_name} revert ./path/to/the/migration.js # Revert one migration
${cmd_name} create <NAME> <DIRECTORY>         # Create a migration in the given directory
`);
  }
}

if (require.main === module) {
  if (!process.env['DATABASE_URL']) {
    throw new Error("DATABASE_URL not set. aborting");
  }
  if (!process.env['MIGRATION_PATHS']) {
    throw new Error("MIGRATION_PATHS not set. aborting");
  }

  exports.cmd(
    'node ./migrate.js',
    process.env['DATABASE_URL'],
    process.env['MIGRATION_PATHS'].split(',')
  );
}
