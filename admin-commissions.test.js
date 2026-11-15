import test from "node:test";
import assert from "node:assert/strict";

// Set this only to a new disposable database. The test inserts account fixtures.
test(
  "admin distributor commission catalog and existing allocation rules",
  {
    skip: !process.env.ADMIN_COMMISSIONS_TEST_DB,
  },
  async () => {
    process.env.DB_NAME = process.env.ADMIN_COMMISSIONS_TEST_DB;
    const { pool, initializeDatabase } = await import("./config/db.js");
    const { getCommissions, setCommission } =
      await import("./controllers/commissionController.js");
    const call = async (handler, role, account, query = {}, body = {}) => {
      const res = {
        code: 200,
        status(value) {
          this.code = value;
          return this;
        },
        json(value) {
          this.body = value;
          return this;
        },
      };
      await handler({ auth: { role, id: account }, query, body }, res);
      return res;
    };
    try {
      await initializeDatabase();
      const makeDistributor = async (suffix) =>
        (
          await pool.query(
            `INSERT INTO distributors
      (business_name,phone,email,business_address,pan,adhar,distributor_image_link,distributor_slug)
      VALUES ('Test',$1,$2,'Test',$3,$4,'test',$5) RETURNING id`,
            [
              `987654321${suffix}`,
              `catalog${suffix}@example.com`,
              `ABCDE123${suffix}F`,
              `12345678901${suffix}`,
              `commission-catalog-${suffix}`,
            ],
          )
        ).rows[0].id;
      const first = await makeDistributor(1);
      const second = await makeDistributor(2);
      const operators = (
        await pool.query(
          "SELECT * FROM service_operators WHERE is_active ORDER BY service,name,id",
        )
      ).rows;
      assert.ok(operators.length > 1);
      const list = (owner, extra = {}) =>
        call(getCommissions, "admin", first, {
          distributor_id: owner,
          limit: 100,
          ...extra,
        });
      let response = await list(first);
      assert.equal(response.code, 200);
      assert.equal(
        response.body.data.length,
        operators.length,
        "include all active companies without existing allocations",
      );
      assert.deepEqual(
        response.body.data.map((row) => row.operator_id),
        operators.map((row) => row.id),
      );
      assert.ok(
        response.body.data.every(
          (row) => row.rate === null && row.id === null && !row.is_active,
        ),
      );
      assert.equal(
        (await pool.query("SELECT COUNT(*) FROM distributor_commission_slabs"))
          .rows[0].count,
        "0",
        "viewing the setup does not create zero allocations",
      );
      const pageOne = await list(first, { limit: 1, page: 1 });
      const pageTwo = await list(first, { limit: 1, page: 2 });
      assert.equal(pageOne.body.data[0].operator_id, operators[0].id);
      assert.equal(pageTwo.body.data[0].operator_id, operators[1].id);
      assert.equal(
        (await list("00000000-0000-0000-0000-000000000000")).code,
        404,
      );
      const operator = operators[0];
      const save = (owner, rate, active = true) =>
        call(
          setCommission,
          "admin",
          first,
          {},
          {
            distributor_id: owner,
            operator_id: operator.id,
            service: operator.service,
            rate,
            is_active: active,
          },
        );
      assert.equal((await save(first, "3")).code, 200);
      assert.equal((await save(second, "4")).code, 200);
      let saved = (await list(first)).body.data.find(
        (row) => row.operator_id === operator.id,
      );
      assert.equal(saved.rate, "3.0000");
      assert.equal(saved.is_active, true);
      assert.equal(
        (await list(second)).body.data.find(
          (row) => row.operator_id === operator.id,
        ).rate,
        "4.0000",
      );
      const retailer = (
        await pool.query(
          `INSERT INTO retailers
      (distributor_id,name,business_name,phone,email,business_address,pan,adhar,password_hash,retailer_slug)
      VALUES ($1,'Retailer','Test','9876543213','catalog-retailer@example.com','Test','FGHIJ1234K','223456789012','test','catalog-retailer') RETURNING id`,
          [first],
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO retailer_commission_slabs(retailer_id,operator_id,rate) VALUES ($1,$2,2.5)",
        [retailer, operator.id],
      );
      saved = (await list(first)).body.data.find(
        (row) => row.operator_id === operator.id,
      );
      assert.equal(
        saved.minimum_rate,
        "2.5000",
        "show the highest active child allocation",
      );
      assert.equal(
        (await save(first, "2")).code,
        409,
        "existing child ceiling remains enforced",
      );
      assert.equal((await save(first, "3", false)).code, 200);
      assert.equal(
        (await list(first)).body.data.find(
          (row) => row.operator_id === operator.id,
        ).is_active,
        false,
      );
      const own = await call(getCommissions, "distributor", first, {
        distributor_id: second,
      });
      assert.equal(
        own.body.data.length,
        1,
        "distributor view still lists only their configured allocations",
      );
      assert.equal(own.body.data[0].distributor_id, first);
      await pool.query(
        "UPDATE service_operators SET is_active=false WHERE id=$1",
        [operator.id],
      );
      assert.equal(
        (await list(first)).body.data.length,
        operators.length - 1,
        "inactive companies are excluded from setup",
      );
    } finally {
      await pool.end();
    }
  },
);
