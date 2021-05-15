exports.up = async function(sql) {
  await sql`
    create table test (
      blah text
    )
  `;
};

exports.down = async function(sql) {
  await sql`
    drop table test
  `;
};
