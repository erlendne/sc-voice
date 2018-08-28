(typeof describe === 'function') && describe("sutta", function() {
    const should = require("should");
    const fs = require('fs');
    const path = require('path');
    const {
        Sutta,
    } = require("../index");
    const SC = path.join(__dirname, '../local/sc');

    it("TESTTESTloadSutta(id, opts) returns a Sutta", function(done) {
        (async function() { try {
            var sutta = await Sutta.loadSutta('mn1');
            var end = 21;
            var header = sutta.excerpt({
                start: 0,
                end: 2,
                prop: 'pli',
            });
            var excerpt = sutta.excerpt({
                start: 0,
                end,
                prop: 'en',
            });
            console.log(header);
            should(excerpt[0]).equal('Middle Discourses 1');
            should(excerpt[end-2]).equal('Why is that?');
            done();
        } catch(e) { done(e); } })();
    });
});

