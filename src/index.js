const postgres = require('postgres');
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

async function hasBeenRun(sql, migration) {
  const [{count}] = await sql`select count (*) from migrations where name=${migration.name}`;
  return count != 0;
}

async function _applyMigration(sql, migration) {
  await sql.begin(async sql => {
    console.log(`Running migration ${migration.name}`);
    
    const migration_code = require(migration.location);
    await migration_code.up(sql);
    await sql`
      insert into migrations (name) values (${migration.name})
    `;
  });
  return true;
}

exports.applyMigration = async function(sql, migration_loc) {
  if (!fs.existsSync(migration_loc)) {
    console.log(`Run aborted. ${migration_loc} not found`);
    return;
  }

  const m = migrationLocationToMigration(migration_loc);

  if (!await hasBeenRun(sql, m)) {
    await _applyMigration(sql, m);
  } else {
    console.log(`Run aborted. ${migration_loc} has already been applied`);
  }
}

exports.revertMigration = async function(sql, migration_loc) {
  if (!fs.existsSync(migration_loc)) {
    console.log(`Revert aborted. ${migration_loc} not found`);
    return;
  }

  const m = migrationLocationToMigration(migration_loc);

  if (!await hasBeenRun(sql, m)) {
    console.log(`Revert aborted because no migration with name=${m.name} found in migrations table`);
    return;
  }

  await sql.begin(async sql => {
    console.log(`Reverting migration ${m.location}`);
    
    const migration_code = require(m.location);
    await migration_code.down(sql);
    await sql`
      delete from migrations where name=${m.name}
    `;
  });
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

async function createMigrationTable(sql) {
  const [{exists}] = await sql`select exists (
    select from pg_catalog.pg_tables 
    where schemaname = 'public'
    and tablename  = 'migrations') as exists`;

  if (!exists) {
    await sql`
      create table migrations (
        name text not null unique,
        timestamp timestamptz not null default now()
      )`;
  }
}

exports.applyAllMigrations = async function(sql, paths) {
  await createMigrationTable(sql);
  const migrations = await findAllMigrations(paths);

  let num_run = 0;
  for (const m of migrations) {
    if (!await hasBeenRun(sql, m)) {
      if (await _applyMigration(sql, m)) num_run++;
    }
  }

  if (num_run) {
    console.log(`Applied ${num_run} migrations`);
  } else {
    console.log(`No new migrations to apply`);
  }
}

exports.createMigration = function(name, directory) {
  const timestamp = Date.now();
  const filename = `${directory}/${timestamp}-${name}.js`;
  fs.writeFileSync(filename,
`exports.up = async function(sql) {
  await sql\`
  \`;
};

exports.down = async function(sql) {
  await sql\`
  \`;
};`);
  console.log(`Migration written to ${filename}`);
}

async function listMigrations(sql, migration_paths) {
  await createMigrationTable(sql);
  const migrations = await findAllMigrations(migration_paths);
  console.log("Applied Y/N     Path to migration");
  for (m of migrations) {
    const run = await hasBeenRun(sql, m);
    console.log(`${run ? 'Y' : 'N'}               ${m.location}`);
  }
  console.log('');
}

exports.cmd = async function(cmd_name, sql, migration_paths, args) {
  if (args[0] == 'all') {
    await exports.applyAllMigrations(sql, migration_paths);

  } else if (args[0] == 'list') {
    await listMigrations(sql, migration_paths);
  } else if (args[0] == 'revert') {
    const migration_loc = args[1];
    if (migration_loc) {
      await exports.revertMigration(sql, migration_loc);
    } else {
      console.log("Path to migration file expected as argument to revert");
    }

  } else if (args[0] == 'apply') {
    const migration_loc = args[1];
    if (migration_loc) {
      await exports.applyMigration(sql, migration_loc);
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
  sql.end();
}

if (require.main === module) {
  if (!process.env['DATABASE_URL']) {
    throw new Error("DATABASE_URL not set. aborting");
  }
  if (!process.env['MIGRATION_PATHS']) {
    throw new Error("MIGRATION_PATHS not set. aborting");
  }

  const [,, ...args] = process.argv;

  const sql = postgres(process.env['DATABASE_URL']);

  exports.cmd(
    'node ./migrate.js',
    sql,
    [ __dirname + "/../migrations" ],
    args
  );
}
