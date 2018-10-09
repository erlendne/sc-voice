(function(exports) {
    const fs = require('fs');
    const path = require('path');
    const http = require('http');
    const https = require('https');
    const Words = require('./words');
    const Sutta = require('./sutta');
    const SuttaCentralId = require('./sutta-central-id');
    const PoParser = require('./po-parser');
    const GuidStore = require('./guid-store');
    const Definitions = require('./definitions');
    const { MerkleJson } = require('merkle-json');
    const LOCAL = path.join(__dirname, '..', '..', 'local');
    const EXPANSION_PATH = path.join(LOCAL, 'expansion.json');
    const UID_EXPANSION_PATH = path.join(LOCAL, 'uid_expansion.json');
    const DEFAULT_LANGUAGE = 'en';
    const DEFAULT_API_URL = 'http://suttacentral.net/api';
    const UID_EXPANSION_URL = 'https://raw.githubusercontent.com/suttacentral'+
        '/sc-data/master/misc/uid_expansion.json';
    const ANY_LANGUAGE = '*';
    const ANY_TRANSLATOR = '*';
    const PO_SUFFIX_LENGTH = '.po'.length;
    const { 
        logger,
        RbServer,
    } = require('rest-bundle');
    RbServer.logDefault();
    logger.level = 'info';

    var singleton;

    class SuttaCentralApi {
        constructor(opts={}) {
            this.language = opts.language || DEFAULT_LANGUAGE;
            this.translator = opts.translator;
            this.expansion = opts.expansion || [{}];
            this.apiStore = opts.apiStore || new GuidStore({
                type: 'ApiStore',
                suffix: '.json',
                storeName: 'api',
            });
            this.apiCacheSeconds = opts.apiCacheSeconds || 24*60*60; 
            this.mj = new MerkleJson({
                hashTag: 'guid',
            });
            this.initialized = false;
            this.apiUrl = opts.apiUrl || DEFAULT_API_URL;
        }

        static loadJson(url) {
            singleton = singleton || new SuttaCentralApi();
            return singleton.loadJson(url);
        }

        loadJson(url) {
            var guid = this.mj.hash({
                method: 'get',
                url,
            });
            var cachedPath = this.apiStore.guidPath(guid);
            var stat = fs.existsSync(cachedPath) && fs.statSync(cachedPath);
            var age = stat && (Date.now() - stat.ctimeMs)/1000 || this.apiCacheSeconds;
            if (age < this.apiCacheSeconds) {
                var res = JSON.parse(fs.readFileSync(cachedPath));
                logger.debug(`SuttaCentralApi.loadJson(${url}) => cached:${guid}`);
                var result = Promise.resolve(res);
            } else {
                var result = this.loadJsonRest(url);
                result.then(res => {
                    fs.writeFileSync(cachedPath, JSON.stringify(res,null,2));
                    logger.info(`loadJson(${url}) => cached:${guid}`);
                });
            }
            return result;
        }

        loadJsonRest(url) {
            return new Promise((resolve, reject) => { try {
                var httpx = url.startsWith('https') ? https : http;
                var req = httpx.get(url, res => {
                    const { statusCode } = res;
                    const contentType = res.headers['content-type'];

                    let error;
                    if (statusCode !== 200) {
                        error = new Error('Request Failed.\n' +
                                          `Status Code: ${statusCode}`);
                    } else if (/^application\/json/.test(contentType)) {
                        // OK
                    } else if (/^text\/plain/.test(contentType)) {
                        // OK
                    } else {
                        error = new Error('Invalid content-type.\n' +
                          `Expected application/json but received ${contentType}`);
                    }
                    if (error) {
                        res.resume(); // consume response data to free up memory
                        logger.error(error.stack);
                        reject(error);
                        return;
                    }

                    res.setEncoding('utf8');
                    let rawData = '';
                    res.on('data', (chunk) => { rawData += chunk; });
                    res.on('end', () => {
                        try {
                            var result = JSON.parse(rawData);
                            logger.debug(`loadJsonRest() ${url} => HTTP200`);
                            resolve(result);
                        } catch (e) {
                            logger.error(e.stack);
                            reject(e);
                        }
                    });
                }).on('error', (e) => {
                    reject(e);
                }).on('timeout', (e) => {
                    logger.error(e.stack);
                    req.abort();
                });
            } catch(e) {reject(e);} });
        }

        static loadUidExpansion(url=UID_EXPANSION_URL) {
            if (fs.existsSync(UID_EXPANSION_PATH)) {
                try {
                    var uid_expansion = JSON.parse(fs.readFileSync(UID_EXPANSION_PATH));
                    return Promise.resolve(uid_expansion);
                } catch(e) {
                    return Promise.reject(e);
                }
            } else {
                return new Promise((resolve, reject) => {
                    SuttaCentralApi.loadJson(url).then(res => {
                        logger.info(`${url}`);
                        fs.writeFileSync(UID_EXPANSION_PATH, JSON.stringify(res,null,2));
                        resolve(res);
                    }).catch(e => {
                        logger.error(`${url} ${e.message}`);
                        reject(e);
                    });
                });
            }
        }

        static loadExpansion(apiUrl=DEFAULT_API_URL) {
            if (fs.existsSync(EXPANSION_PATH)) {
                try {
                    var expansion = JSON.parse(fs.readFileSync(EXPANSION_PATH));
                    return Promise.resolve(expansion);
                } catch(e) {
                    return Promise.reject(e);
                }
            } else {
                return new Promise((resolve, reject) => {
                    var url = `${apiUrl}/expansion`;
                    SuttaCentralApi.loadJson(url).then(res => {
                        logger.info(`${url}`);
                        fs.writeFileSync(EXPANSION_PATH, JSON.stringify(res,null,2));
                        resolve(res);
                    }).catch(e => {
                        logger.error(`${url} ${e.message}`);
                        reject(e);
                    });
                });
            }
        }

        initialize() {
            var that = this;
            return new Promise((resolve,reject) => { try {
                (async function() {
                    await SuttaCentralApi.loadExpansion(that.apiUrl).then(res => {
                        that.expansion = res;
                        that.initialized = true;
                    }).catch(e => reject(e));
                    await SuttaCentralApi.loadUidExpansion().then(res => {
                        that.uid_expansion = res;
                        that.initialized = true;
                    }).catch(e => reject(e));
                    resolve(that);
                })();
            } catch(e) {reject(e);} });
        }

        expandAbbreviation(abbr) {
            if (!this.initialized) {
                throw new Error('initialize() must be called');
            }
            return this.expansion[0][abbr];
        }

        suttaFromApiText(apiJson) {
            if (!this.initialized) {
                throw new Error('initialize() must be called');
            }
            var debug = 0;

            var msStart = Date.now();
            var translation = apiJson.translation;
            var lang = translation.lang;
            var suttaplex = apiJson.suttaplex;
            var uid = suttaplex.uid;

            var html = translation.text;
            var resultAside = (/<aside/um).exec(html);
            if (resultAside) {
                let start = html.indexOf('>', resultAside.index)+1;
                let end = html.indexOf('</aside', start);
                var metaarea = html.substring(start, end);
                let reAside = new RegExp('<aside[^]*</aside>', 'gum');
                html = html.replace(reAside, '');
            } else {
                var metaArea = '';
            }

            var iH = html.match(/<h[0-9]/um);
            var iP = html.indexOf('<p');
            if (iH >= 0) {
                html = html.replace(/[^]*?(<h[0-9][^>]*)>/um, '$1');
            } else {
                html = html.replace(/[^]*?<p[^>]*>/um, '<p>');
            }
            html = html.replace(/<\/?div[^>]*>\n*/gum,'');
            html = html.replace(/<\/?blockquote[^>]*>\n*/gum,'');
            html = html.replace(/<\/?br[^>]*>\n*/gum,' ');

            var ipLast = html.lastIndexOf('</p>');
            var pEnd = '</p>';
            html = html.substring(0, html.lastIndexOf(pEnd)+pEnd.length);
            var lines = html.split('\n');

            var debug1 = 0;
            var debug2 = debug1 + 10;
            if (debug) {
                lines.slice(debug1, debug2).forEach((l,i) => {
                    var head = l.substring(0,40);
                    var tail = l.substring(l.length-10);
                    console.log(`${i+debug1} ${head}...${tail}"`)
                });
            }

            var section = 1;
            if (html.indexOf('id="sc') >= 0) {
            } else {
            }
            var id = '.0';
            var textSegments = lines.map((line,i) => {
                if (line.indexOf('id="sc') > 0) {
                    id = line.replace(/.*"sc([0-9]+)[^]*/u,'.$1');
                }
                if (i) {
                    section = line.match(/^<h[2-9]/u) ? section+1 : section;
                }
                var scid = `${uid}:${section}${id}.${i+1}`;
                line = line.replace(/<\/?[^>]*>/gu,'');
                return {
                    scid,
                    [lang]: line,
                }
            });

            if (debug) {
                console.log('elapsed', ((Date.now() - msStart)/1000).toFixed(3));
                textSegments.slice(debug1, debug2).forEach((seg,i) => {
                    var l = seg.en;
                    var len = Math.min(20,l.length/2-1);
                    console.log(`${i+debug1} ${seg.scid} "` +
                        l.substring(0,len)+
                        '...'+
                        `${l.substring(seg.en.length-len)}"`)
                });
            }

            var collId = uid.replace(/[0-9.-]+/u, '');
            var collNum = uid.replace(/[a-z]*/iu, '');
            var collNames = this.expandAbbreviation(collId);
            var collName = collNames && collNames[collNames.length-1];
            var headerSegments = [{
                scid:`${uid}:0.1`,
                [lang]: `${collName || colId} ${collNum}`,
            },{
                scid:`${uid}:0.2`,
                [lang]: `${translation.title}`,
                [suttaplex.root_lang]: `${suttaplex.original_title}`,
            }];
            return new Sutta({
                sutta_uid: uid,
                support: Definitions.SUPPORT_LEVELS.Legacy,
                metaarea,
                segments: headerSegments.concat(textSegments),
                translation,
            });
        }

        normalizeScid(id) {
            if (id == null) {
                throw new Error('Sutta reference identifier is required');
            }
            var scid = SuttaCentralId.normalizeSuttaId(id);
            if (scid == null) {
                throw new Error(`Keyword search is not yet implemented:${id}`);
            }
            try {
                var popath = PoParser.suttaPath(scid);
                var basename = path.basename(popath);
                scid = basename.substring(0, basename.length-PO_SUFFIX_LENGTH);
                scid = scid.replace(/([^0-9])0*/gu,'$1');
                var support = Definitions.SUPPORT_LEVELS.Supported;
            } catch(e) {
                // ignore and pass to api (possibly not in Pootl)
                logger.debug(e.stack);
                var support = Definitions.SUPPORT_LEVELS.Legacy;
            }
            return {
                support,
                scid,
            };
        }

        loadSuttaJson(id, language, translator) {
            var that = this;
            return new Promise((resolve, reject) => (async function(){ 
                try {
                    var {
                        scid,
                        support,
                    } = that.normalizeScid({
                        scid: id,
                        language,
                        translator,
                    });
                    var apiSuttas = `${that.apiUrl}/suttas`;
                    var request = `${apiSuttas}/${scid}`;
                    if (translator && translator !== ANY_TRANSLATOR) {
                        request += `/${translator}`;
                    }
                    if (language && language !== ANY_LANGUAGE) {
                        request += `?lang=${language}`;
                    }
                    logger.debug(`loadSuttaJson()`, request);

                    var result = await SuttaCentralApi.loadJson(request);
                    result.support = support;
                    var suttaplex = result.suttaplex;
                    var translations = suttaplex && suttaplex.translations;
                    if (translations == null || translations.length === 0) {
                        throw new Error(`loadSuttaJson() no sutta found for id:${scid}`);
                    }
                    if (translations && language && language !== ANY_LANGUAGE) {
                        suttaplex.translations = 
                            translations.filter(t => t.lang === language);
                    }
                    resolve(result);
                } catch(e) {
                    reject(e);
                } 
            })()); 
        }

        loadSuttaplexJson(scid, lang, author_uid) {
            var that = this;
            return new Promise((resolve, reject) => (async function(){ 
                try {
                    var sutta_uid = SuttaCentralId.normalizeSuttaId(scid);
                    var request = `${that.apiUrl}/suttaplex/${sutta_uid}`;
                    logger.debug(`loadSuttaPlexJson(${scid}) ${request}`);

                    var result = await SuttaCentralApi.loadJson(request);
                    var suttaplex = result[0];
                    var translations = suttaplex && suttaplex.translations;
                    if (translations == null || translations.length === 0) {
                        throw new Error(`loadSuttaplexJson() sutta not found:${sutta_uid}`);
                    }
                    suttaplex.translations = 
                        translations.filter(t => 
                            (!lang || lang === ANY_LANGUAGE || t.lang === lang)
                            &&
                            (!author_uid || t.author_uid === author_uid)
                        );
                    translations.sort((a,b) => {
                        if (a.segmented === b.segmented) {
                            return (a.author_uid||'').localeCompare(b.author_uid||'');
                        }
                        return a.segmented ? 1 : -1;
                    });
                    logger.debug(`SuttaCentralApi.loadSuttaplexJson() `+
                        `${JSON.stringify(suttaplex,null,2)}`);
                    resolve(suttaplex);
                } catch(e) {
                    reject(e);
                } 
            })()); 
        }

        loadSutta(...args) {
            var that = this;
            return new Promise((resolve, reject) => { try {
                (async function(){ try {
                    if (typeof args[0] === "string") {
                        var opts = {
                            scid: args[0],
                            language: args[1] || that.language,
                            translator: args[2] || that.translator,
                        }
                    } else {
                        opts = args[0];
                    }
                    var sutta_uid = SuttaCentralId.normalizeSuttaId(opts.scid);
                    var language = opts.language;
                    var author_uid = opts.translator;
                    var suttaplex = await that
                        .loadSuttaplexJson(sutta_uid, language, author_uid);
                    var translations = suttaplex.translations;
                    if (translations == null || translations.length == 0) {
                        logger.info(`SuttaCentralApi.loadSutta(${sutta_uid},${language}) `+
                            `=> no translations`);
                        resolve(null);
                        return;
                    }

                    author_uid = translations[0].author_uid;
                    var result = await that.loadSuttaJson(sutta_uid, language, author_uid);
                    if (result.translation == null && translations.length>0) {
                        var trans = translations.filter(t=>t.segmented)[0];
                        if (trans == null) {
                            console.log('debug3 no segmented');
                            trans = translations[0];
                        }
                        var {
                            author_uid,
                            lang,
                        } = trans;

                        var uid = result.suttaplex.uid;
                        // multiple translations found, using first
                        var result = await that.loadSuttaJson(uid, lang, author_uid);
                    }
                    var translation = result.translation;
                    if (translation) {
                        var author_uid = translation.author_uid;
                        if (translation.text) {
                            var sutta = that.suttaFromApiText(result);
                        } else {
                            var rootStrings = result.root_text.strings;
                            var segObj = {};
                            Object.keys(rootStrings).forEach(scid => {
                                segObj[scid] = segObj[scid] || { scid };
                                segObj[scid].pli = rootStrings[scid];
                                segObj[scid].en = "";
                            });
                            var transStrings = translation.strings;
                            Object.keys(transStrings).forEach(scid => {
                                segObj[scid] = segObj[scid] || { scid };
                                var text = transStrings[scid];
                                text = text.replace(/<\/?i>/gum, '');
                                segObj[scid][translation.lang] = text;
                            });
                            var segments = Object.keys(segObj).map(scid => segObj[scid]);
                            var sutta = new Sutta({
                                sutta_uid: result.suttaplex.uid,
                                support: result.support,
                                segments,
                                translation,
                            });
                        }
                        sutta.author_uid = translation.author_uid;
                        sutta.suttaplex = result.suttaplex,
                        resolve(sutta);
                    } else { // no unique translation 
                        resolve(result);
                    }
                } catch(e) {reject(e);} })();
            } catch(e) {reject(e);} });
        }
        
    }

    module.exports = exports.SuttaCentralApi = SuttaCentralApi;
})(typeof exports === "object" ? exports : (exports = {}));

