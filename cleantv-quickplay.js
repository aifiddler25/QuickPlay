/* CleanTV QuickPlay 1.3.1. Standalone Lampa plugin; no background service. */
(function (root, factory) {
    var core = factory();
    if (typeof module === 'object' && module.exports) module.exports = core;
    if (!root || !root.document) return;
    if (root.CleanTVQuickPlay) return;
    var L = root.Lampa, $ = root.jQuery || root.$;
    if (!L || !$ || !L.Listener || !L.Parser || !L.Torrent || !L.Torserver || !L.Reguest) return;

    var current = null, episodeLoad = null, resumeView = null;
    var MAX_CANDIDATES = 12;
    var icon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    var resumeIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>';
    function setting(key, fallback) { return L.Storage.get('cleantv_qp_' + key, fallback); }
    function log(event, details) {
        var record = { event: event };
        Object.keys(details || {}).forEach(function (k) { record[k] = details[k]; });
        root.CleanTVQuickPlay.last = record;
        console.log('[CleanTVQuickPlay] ' + JSON.stringify(record));
    }
    function restoreFocus() {
        var active = L.Activity.active();
        if (active && active.activity && active.activity.toggle) active.activity.toggle();
        else L.Controller.toggle('content');
    }
    function history() {
        var items = setting('resume', []);
        return Array.isArray(items) ? items : [];
    }
    function resumeRecord(movie) {
        var key = core.resumeKey(movie);
        return history().filter(function (r) { return r && r.key === key; })[0];
    }
    function resumeState(movie) {
        var record = resumeRecord(movie);
        if (!record || !record.hash || !record.file || !record.timelineHash || !L.Timeline) return null;
        var timeline = L.Timeline.view(record.timelineHash);
        return core.canResume(timeline) ? { record: record, timeline: timeline } : null;
    }
    function refreshResume() {
        if (!resumeView) return;
        var state = resumeState(resumeView.movie), text = 'Продолжить просмотр', details = [];
        if (state) {
            var context = state.record.context;
            if (context) details.push(context.season + ' сезон, ' + context.episode + ' серия');
            if (Number(state.timeline.time) > 0) details.push(core.timeLabel(state.timeline.time));
            if (details.length) text += '\n' + details.join(' · ');
        }
        resumeView.button.toggleClass('hide', !state).find('span').text(text);
    }
    function remember(s, candidate, file, timeline) {
        if (!timeline || !timeline.hash || !s.hash || !L.Storage.set) return;
        var key = core.resumeKey(s.movie);
        if (!key) return;
        var record = { key: key, hash: s.hash, title: candidate.Title,
            file: { path: file.path, length: Number(file.length) || 0 },
            timelineHash: timeline.hash, context: s.context || null, minutes: s.minutes,
            seeds: Number(candidate.Seeders) || 0 };
        var items = history().filter(function (r) { return r && r.key !== key; });
        items.unshift(record);
        // Only source identity is stored here; Lampa owns persistent playback positions.
        L.Storage.set('cleantv_qp_resume', items.slice(0, 40));
        refreshResume();
    }
    function searchParams(movie, context) {
        var year = (movie.first_air_date || movie.release_date || '').slice(0, 4);
        var local = movie.title || movie.name || '';
        var original = movie.original_title || movie.original_name || local;
        var combinations = { df: original, df_year: original + ' ' + year,
            df_lg: original + ' ' + local, df_lg_year: original + ' ' + local + ' ' + year,
            lg: local, lg_year: local + ' ' + year, lg_df: local + ' ' + original,
            lg_df_year: local + ' ' + original + ' ' + year };
        var season = context && context.season ? ' S' + ('0' + context.season).slice(-2) : '';
        return { url: '', title: 'Торренты', component: 'torrents', page: 1, movie: movie,
            search: (combinations[L.Storage.field('parse_lang')] || original) + season,
            search_one: local + season, search_two: original + season };
    }
    function manual(movie, context) { L.Activity.push(searchParams(movie, context)); }
    function stop(s, close) {
        if (!s || !s.active) return;
        s.active = false;
        clearTimeout(s.deadline);
        clearTimeout(s.poll);
        if (s.loading && L.Loading) { s.loading = false; L.Loading.stop(); }
        if (s.fileListener) L.Listener.remove('torrent_file', s.fileListener);
        if (s.hash && !s.keep && !s.existing[s.hash]) {
            s.net.silent(s.url + '/torrents', function () {}, function () {},
                JSON.stringify({ action: 'drop', hash: s.hash }), { dataType: 'text' });
        }
        if (current === s) current = null;
        if (close) { L.Modal.close(); restoreFocus(); }
    }
    function fallback(s, text) {
        if (!s.active) return;
        log('manual', { reason: text });
        stop(s, true);
        L.Noty.show(text, { time: 6500 });
        manual(s.movie, s.context);
    }
    function status(s, text) {
        if (s.active) L.Modal.update($('<div style="padding:1em;line-height:1.6"></div>').text(text));
    }
    function request(s, body, success, failure, text) {
        s.net.timeout(7000);
        s.net.silent(s.url + '/torrents', function (json) {
            if (!s.active) {
                if (body.action === 'add' && json.hash && !s.existing[json.hash]) {
                    s.net.silent(s.url + '/torrents', function () {}, function () {},
                        JSON.stringify({ action: 'drop', hash: json.hash }), { dataType: 'text' });
                }
                return;
            }
            success(json);
        }, function () { if (s.active) failure(); }, JSON.stringify(body), text ? { dataType: 'text' } : undefined);
    }
    function launch(s, candidate, file) {
        if (s.context) return launchEpisode(s, candidate, file);
        s.keep = true;
        // The normal Lampa player owns buffering and Back after the handoff.
        clearTimeout(s.deadline);
        clearTimeout(s.poll);
        L.Modal.close();
        var launched = false;
        s.fileListener = function (e) {
            if (s.active && e.type === 'list_close') { stop(s, false); return; }
            if (!s.active || !e.params || !e.params.movie || String(e.params.movie.id) !== String(s.movie.id)) return;
            if (e.type === 'render' && e.element && String(e.element.id) === String(file.id) && !launched) {
                launched = true;
                // Let Lampa finish building its playlist before selecting the checked file.
                setTimeout(function () {
                    if (s.active) e.item.trigger('hover:enter');
                }, 100);
            }
            if (e.type === 'onenter' && e.element && String(e.element.id) === String(file.id)) {
                remember(s, candidate, file, e.element.timeline);
                log('playing', { seeds: Number(candidate.Seeders), quality: s.quality, file: file.id });
                stop(s, false);
            }
        };
        L.Listener.follow('torrent_file', s.fileListener);
        log('selected', { seeds: Number(candidate.Seeders), quality: s.quality, file: file.id });
        L.Noty.show('Автовыбор · сидов ' + candidate.Seeders);
        var element = {};
        Object.keys(candidate).forEach(function (k) { element[k] = candidate[k]; });
        element.title = candidate.Title;
        element.poster = s.movie.img || '';
        element.MagnetUri = s.hash ? 'magnet:?xt=urn:btih:' + s.hash : candidate.MagnetUri;
        L.Torrent.start(element, s.movie);
    }
    function resume(movie) {
        if (!setting('enabled', true)) return;
        var state = resumeState(movie);
        if (!state) { refreshResume(); return L.Noty.show('Нет незавершённого просмотра.'); }
        if (!L.Torserver.url() || !L.Storage.field('internal_torrclient')) {
            return L.Noty.show('Для продолжения нужен встроенный клиент и настроенный TorrServer.');
        }
        if (current) stop(current, true);
        var record = state.record;
        var s = { active: true, movie: movie, context: record.context, minutes: record.minutes,
            resume: record, url: L.Torserver.url().replace(/\/$/, ''), net: new L.Reguest(), existing: {} };
        current = s;
        L.Modal.open({ title: 'Продолжить просмотр', size: 'medium',
            html: $('<div style="padding:1em">Открываю сохранённую раздачу…</div>'),
            onBack: function () { stop(s, true); } });
        function failed() { fallback(s, 'Сохранённая раздача недоступна. Выбери другую вручную.'); }
        s.deadline = setTimeout(failed, 45000);
        request(s, { action: 'list' }, function (list) {
            if (!Array.isArray(list)) return failed();
            list.forEach(function (t) { if (t.hash) s.existing[t.hash] = true; });
            request(s, { action: 'add', link: 'magnet:?xt=urn:btih:' + record.hash,
                title: record.title, save_to_db: false }, function (json) {
                if (!json.hash) return failed();
                s.hash = json.hash;
                var started = Date.now();
                function poll() {
                    if (!s.active) return;
                    if (Date.now() - started > 14000) return failed();
                    request(s, { action: 'get', hash: s.hash }, function (torrent) {
                        if (!torrent.file_stats || !torrent.file_stats.length) {
                            s.poll = setTimeout(poll, 1100); return;
                        }
                        var file = core.resumeFile(torrent.file_stats, record.file);
                        if (!file) return failed();
                        launchEpisode(s, { Title: record.title, Seeders: record.seeds }, file);
                    }, function () { s.poll = setTimeout(poll, 1100); });
                }
                poll();
            }, failed);
        }, failed);
    }
    function next(s) {
        if (!s.active) return;
        if (s.hash && !s.existing[s.hash]) {
            var old = s.hash;
            s.hash = null;
            request(s, { action: 'drop', hash: old }, function () { next(s); }, function () { next(s); }, true);
            return;
        }
        s.hash = null;
        if (s.index >= s.candidates.length || s.index >= MAX_CANDIDATES) return fallback(s, 'Не найден файл с выбранным качеством. Выбери вручную.');
        var candidate = s.candidates[s.index++];
        status(s, 'Проверяю раздачу ' + s.index + ' из ' + Math.min(MAX_CANDIDATES, s.candidates.length) + ' · сидов ' + candidate.Seeders);
        request(s, { action: 'add', link: candidate.MagnetUri || candidate.Link,
            title: candidate.Title, save_to_db: false }, function (json) {
            if (!json.hash) return next(s);
            s.hash = json.hash;
            var started = Date.now();
            function poll() {
                if (!s.active) return;
                if (Date.now() - started > 14000) return next(s);
                request(s, { action: 'get', hash: s.hash }, function (torrent) {
                    if (!torrent.file_stats || !torrent.file_stats.length) {
                        s.poll = setTimeout(poll, 1100); return;
                    }
                    var file = core.pickFile(torrent.file_stats, s.context, function (f) {
                        try { return L.Torserver.parse({ movie: s.movie, files: torrent.file_stats,
                            filename: f.path, path: f.path }); } catch (e) { return {}; }
                    });
                    if (!file || !core.qualityMatches(candidate.Title, file.path, s.quality, true, candidate.ffprobe)) return next(s);
                    launch(s, candidate, file);
                }, function () { s.poll = setTimeout(poll, 1100); });
            }
            poll();
        }, function () { next(s); });
    }
    function run(movie, context) {
        if (current) stop(current, true);
        var minutes = Number(context && context.minutes) || Number(movie.runtime) || 0;
        if (!L.Torserver.url() || !L.Storage.field('internal_torrclient')) {
            L.Noty.show('Для автовыбора нужен встроенный клиент и настроенный TorrServer.');
            return manual(movie, context);
        }
        var s = { active: true, movie: movie, context: context, minutes: minutes,
            url: L.Torserver.url().replace(/\/$/, ''),
            net: new L.Reguest(), existing: {}, index: 0, candidates: [] };
        s.quality = String(setting('quality', 'auto'));
        if (['auto', '480', '720', '1080', '2160'].indexOf(s.quality) < 0) s.quality = 'auto';
        s.minSeeds = Number(setting('min_seeds', '1'));
        if (!(s.minSeeds >= 1 && s.minSeeds <= 10000)) s.minSeeds = 1;
        current = s;
        L.Modal.open({ title: 'Смотреть автоматически', size: 'medium',
            html: $('<div style="padding:1em">Ищу раздачи с выбранным качеством…</div>'),
            onBack: function () { log('cancelled'); stop(s, true); } });
        // Include parser time and bounded add/get/drop requests for all candidates.
        s.deadline = setTimeout(function () { fallback(s, 'Автовыбор занял слишком много времени. Выбери вручную.'); }, MAX_CANDIDATES * 35000 + 60000);
        request(s, { action: 'list' }, function (list) {
            if (!Array.isArray(list)) return fallback(s, 'TorrServer вернул неизвестный ответ.');
            list.forEach(function (t) { if (t.hash) s.existing[t.hash] = true; });
            L.Parser.get(searchParams(movie, context), function (data) {
                if (!s.active) return;
                s.candidates = core.rank(data && data.Results || [], movie, { quality: s.quality, minSeeds: s.minSeeds });
                log('candidates', { count: s.candidates.length });
                if (!s.candidates.length) return fallback(s, 'Нет раздач с выбранным качеством и минимум ' + s.minSeeds + ' сидов. Выбери вручную.');
                next(s);
            }, function () { fallback(s, 'Поиск раздач не ответил. Попробуй ручной выбор.'); });
        }, function () { fallback(s, 'TorrServer недоступен. Проверь локальный сервер.'); });
    }
    function launchEpisode(s, candidate, file) {
        clearTimeout(s.deadline);
        L.Modal.close();
        // An external Android player does not call Player.callback on return.
        // Restore the card now so Loading and VLC never inherit a dead modal.
        restoreFocus();
        if (!L.Player || !L.Torserver.stream) return fallback(s, 'Плеер недоступен. Выбери вручную.');
        var context = s.context || {};
        var url = L.Torserver.stream(file.path, s.hash, file.id);
        log('selected', { seeds: Number(candidate.Seeders), quality: s.quality,
            file: file.id, season: context.season, episode: context.episode });
        var parsed = {};
        try { parsed = L.Torserver.parse({ movie: s.movie, files: [file], filename: file.path, path: file.path }); } catch (ignore) {}
        var timeline = null;
        var timelineHash = s.resume ? s.resume.timelineHash : parsed.hash;
        if (L.Timeline && timelineHash) {
            timeline = L.Timeline.view(timelineHash, L.Timeline.link(s.movie, context.season, context.episode));
            if (!timeline.duration && s.minutes) timeline.duration = s.minutes * 60;
        }
        var subtitle = s.context ? 'Сезон ' + context.season + ' · Серия ' + context.episode : '';
        var data = { url: url.replace('&preload', '&play'), title: context.episodeTitle || s.movie.title || s.movie.name,
            first_title: s.movie.name || s.movie.title, card: s.movie, season: context.season,
            episode: context.episode, timeline: timeline, torrent_hash: s.hash, path: file.path,
            subtitle: subtitle,
            ffprobe: candidate.ffprobe || false };
        function play() {
            if (!s.active) return;
            if (s.loading && L.Loading) { s.loading = false; L.Loading.stop(); }
            restoreFocus();
            s.keep = true;
            if (L.Favorite) L.Favorite.add('history', s.movie, 100);
            remember(s, candidate, file, timeline);
            L.Player.play(data);
            L.Player.playlist([data]);
            L.Player.callback(function () {
                if (!s.existing[s.hash]) s.net.silent(s.url + '/torrents', function () {}, function () {},
                    JSON.stringify({ action: 'drop', hash: s.hash }), { dataType: 'text' });
                restoreFocus();
            });
            log('playing', { seeds: Number(candidate.Seeders), quality: s.quality,
                file: file.id, season: context.season, episode: context.episode, resume: !!s.resume });
            stop(s, false);
        }
        // Use the existing stream/preload setting, without asking TMDB for the season again.
        if (url.indexOf('&preload') < 0 || !L.Loading) return play();
        s.loading = true;
        L.Loading.start(function () { stop(s, false); restoreFocus(); }, s.context ? 'Буферизация серии' : 'Буферизация фильма');
        var first = true, lastBytes = 0, lastChange = Date.now();
        function buffer() {
            if (!s.active) return;
            s.net.timeout(2500);
            s.net.silent(first ? url : url.replace('&preload', '&stat'), function (res) {
                if (!s.active) return;
                var bytes = Number(res.preloaded_bytes) || 0, size = Number(res.preload_size) || 0;
                if (bytes > lastBytes) { lastBytes = bytes; lastChange = Date.now(); }
                if ((size > 0 && bytes / size >= 0.95) || (res.preload_size === 0 && typeof res.preloaded_bytes === 'number')) return play();
                if (Date.now() - lastChange > 30000) return fallback(s, 'Раздача не отдаёт данные. Выбери другую вручную.');
                if (L.Loading.setProgress) L.Loading.setProgress(size > 0 ? Math.min(100, bytes * 100 / size) : 0,
                    subtitle);
                s.poll = setTimeout(buffer, 900);
            }, function () {
                if (!s.active) return;
                if (Date.now() - lastChange > 30000) return fallback(s, 'Нет ответа потока. Выбери вручную.');
                s.poll = setTimeout(buffer, 900);
            });
            first = false;
        }
        buffer();
    }
    function chooseEpisode(movie, season, episodes) {
        var items = core.episodeChoices(season, episodes, movie);
        if (!items.length) { L.Noty.show('Не удалось получить список серий.'); return manual(movie); }
        L.Select.show({ title: 'Выбери серию', items: items,
            onBack: restoreFocus, onSelect: function (episode) {
                run(movie, episode);
            } });
    }
    function loadEpisodes(movie, season) {
        if (episodeLoad) { episodeLoad.active = false; clearTimeout(episodeLoad.timer); }
        var load = { active: true };
        episodeLoad = load;
        function finish(episodes, failed) {
            if (!load.active) return;
            load.active = false; clearTimeout(load.timer); episodeLoad = null;
            L.Modal.close();
            if (failed) L.Noty.show('Названия серий недоступны. Открываю список по номерам.');
            chooseEpisode(movie, season, episodes);
        }
        L.Modal.open({ title: 'Загрузка серий', html: $('<div style="padding:1em">Получаю список серий…</div>'),
            onBack: function () { load.active = false; clearTimeout(load.timer); episodeLoad = null; L.Modal.close(); restoreFocus(); } });
        load.timer = setTimeout(function () { finish([], true); }, 4500);
        // Api.seasons ignores an error callback and opens Lampa's global error modal.
        // The source's get API has a proper error callback; a late reply is ignored.
        var tmdb = L.Api && L.Api.sources && L.Api.sources.tmdb;
        if (!tmdb || typeof tmdb.get !== 'function') return finish([], true);
        try {
            tmdb.get('tv/' + movie.id + '/season/' + season.season_number, {}, function (data) {
                finish(data && data.episodes, false);
            }, function () { finish([], true); });
        } catch (error) { finish([], true); }
    }
    function pickEpisode(movie) {
        var seasons = (movie.seasons || []).filter(function (s) { return s.season_number > 0 && s.episode_count > 0; });
        if (!seasons.length) {
            L.Noty.show('Нет списка серий для точного автовыбора.'); return manual(movie);
        }
        L.Select.show({ title: 'Выбери сезон', items: seasons.map(function (s) {
            return { title: s.name || 'Сезон ' + s.season_number, metadata: s };
        }), onBack: restoreFocus, onSelect: function (season) {
            loadEpisodes(movie, season.metadata);
        } });
    }
    function start(movie) {
        if (!movie || !setting('enabled', true)) return;
        if (movie.number_of_seasons || movie.original_name || movie.first_air_date) pickEpisode(movie);
        else run(movie, null);
    }
    function addButton(e) {
        if (!setting('enabled', true) || e.type !== 'build' || (e.name && e.name !== 'start')) return;
        var body = e.item && e.item.html || e.body || (e.object && e.object.activity && e.object.activity.render());
        var movie = e.data && e.data.movie || e.data && e.data.title && e.data || e.props && e.props.get && e.props.get('movie');
        if (!body || !movie) return;
        var container = $(body).find('.full-start-new__buttons, .full-start__buttons').first();
        if (!container.length || container.find('.cleantv-quickplay').length) return;
        var button = $('<div class="full-start__button selector cleantv-quickplay">' + icon + '<span>Смотреть автоматически</span></div>');
        button.on('hover:enter', function () { start(movie); });
        container.prepend(button);
        // Lampa hides ordinary button captions until focus; keep this action identifiable.
        var resumeButton = $('<div class="full-start__button selector cleantv-quickplay-resume hide">' + resumeIcon + '<span style="display:inline-block;white-space:pre-line;font-size:.75em;line-height:1.15">Продолжить просмотр</span></div>');
        resumeButton.on('hover:enter', function () { resume(movie); });
        container.prepend(resumeButton);
        resumeView = { movie: movie, button: resumeButton };
        refreshResume();
    }
    function init() {
        if (root.CleanTVQuickPlay.initialized) return;
        root.CleanTVQuickPlay.initialized = true;
        if (L.SettingsApi && L.SettingsApi.addComponent && L.SettingsApi.addParam) {
            L.SettingsApi.addComponent({ component: 'cleantv_quickplay', name: 'Смотреть автоматически', icon: icon });
            L.SettingsApi.addParam({ component: 'cleantv_quickplay',
                param: { name: 'cleantv_qp_quality', type: 'select', default: 'auto',
                    values: { 'auto': 'Авто — до 1080p', '480': '480p', '720': '720p', '1080': '1080p', '2160': '2160p (4K)' } },
                field: { name: 'Качество видео', description: 'Точный выбор без перехода на более низкое качество. Неизвестное разрешение исключается.' } });
            L.SettingsApi.addParam({ component: 'cleantv_quickplay',
                param: { name: 'cleantv_qp_min_seeds', type: 'select', default: '1',
                    values: { '1': '1', '3': '3', '5': '5', '10': '10', '20': '20', '50': '50', '100': '100' } },
                field: { name: 'Минимум сидов (раздающих)', description: 'Источники с меньшим числом раздающих пропускаются.' } });
            L.SettingsApi.addParam({ component: 'cleantv_quickplay',
                param: { name: 'cleantv_qp_enabled', type: 'trigger', default: true },
                field: { name: 'Включить автовыбор', description: 'Ручной выбор торрентов всегда остаётся доступен.' } });
        }
        L.Listener.follow('full', addButton);
        if (L.Timeline && L.Timeline.listener) L.Timeline.listener.follow('update', refreshResume);
        log('ready', { version: '1.3.1', build: '20261116.3' });
    }
    root.CleanTVQuickPlay = { version: '1.3.1', start: start, resume: resume, cancel: function () {
        if (episodeLoad) { episodeLoad.active = false; clearTimeout(episodeLoad.timer); episodeLoad = null; L.Modal.close(); restoreFocus(); }
        stop(current, true);
    } };
    if (root.appready) init();
    else L.Listener.follow('app', function (e) { if (e.type === 'ready') init(); });
})(typeof window !== 'undefined' ? window : null, function () {
    function normalize(text) {
        return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
    }
    function badFormat(text) {
        return /4320p|\b(?:8k|av1|remux|camrip|hdcam|telesync|tsrip)\b/i.test(text || '');
    }
    function resolution(text) {
        var match = /(?:^|[^\d])(480|576|720|1080|2160)[pi](?:\d{2,3})?(?:\b|[._\s-])/i.exec(text || '');
        if (match) return Number(match[1]);
        match = /(?:640|720|1280|1920|3840)[xх×](480|576|720|1080|2160)/i.exec(text || '');
        if (match) return Number(match[1]);
        if (/\b(?:4k|uhd)\b/i.test(text || '')) return 2160;
        return 0;
    }
    function qualityMatches(title, path, quality, final, probe) {
        if (badFormat(title) || badFormat(path)) return false;
        var video = Array.isArray(probe) ? probe.filter(function (s) { return s.codec_type === 'video'; })[0] : null;
        var c = 0;
        if (video && (Number(video.width) > 0 || Number(video.height) > 0)) {
            var width = Number(video.width) || 0, height = Number(video.height) || 0;
            c = width > 4096 || height > 2160 ? 4320 : width > 2560 || height > 1440 ? 2160 :
                width > 1920 || height > 1080 ? 1440 : width > 1280 || height > 720 ? 1080 :
                width > 854 || height > 576 ? 720 : height > 480 ? 576 : 480;
        }
        var a = resolution(title), b = resolution(path), size = c || b || a;
        quality = String(quality || 'auto');
        if (quality === 'auto') return Math.max(a, b, c) <= 1080;
        if (!size) return !final;
        return size === Number(quality);
    }
    function titleMatches(title, movie) {
        var source = ' ' + normalize(title) + ' ';
        var expectedYear = Number((movie.release_date || '').slice(0, 4));
        return [movie.title, movie.name, movie.original_title, movie.original_name].some(function (t) {
            var name = normalize(t);
            var position = name ? source.indexOf(' ' + name + ' ') : -1;
            if (position < 0) return false;
            var year = /\b(19\d{2}|20\d{2})\b/.exec(source.slice(position + name.length + 1));
            return !expectedYear || !year || Math.abs(Number(year[1]) - expectedYear) <= 1;
        });
    }
    function rank(results, movie, options) {
        options = options || {};
        return results.filter(function (r) {
            return Number(r.Seeders) >= (options.minSeeds || 1) && (r.MagnetUri || r.Link) && titleMatches(r.Title, movie) && qualityMatches(r.Title, '', options.quality, false, r.ffprobe);
        }).slice().sort(function (a, b) { return Number(b.Seeders) - Number(a.Seeders) || Number(a.Size || 0) - Number(b.Size || 0); });
    }
    function isVideo(file) {
        return /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts)$/i.test(file.path || '') &&
            !/(?:^|[\s/_.-])(sample|trailer|extras?|bonus|тизер|трейлер)(?:[\s/_.-]|$)/i.test(file.path || '');
    }
    function pickFile(files, context, parser) {
        var video = files.filter(isVideo);
        if (context && context.episode) {
            var matched = video.filter(function (file) {
                var path = file.path || '';
                var direct = /S(\d{1,2})[ ._-]*E(\d{1,3})(?!\d)/i.exec(path) || /(\d{1,2})x(\d{1,3})(?!\d)/i.exec(path);
                if (direct) return Number(direct[1]) === context.season && Number(direct[2]) === context.episode && !/E\d+(?:[ ._-]*E|\s*[-+]\s*)\d+/i.test(path);
                var info = parser ? parser(file) : {};
                return Number(info.season) === context.season && Number(info.episode) === context.episode;
            });
            return matched.length === 1 ? matched[0] : null;
        }
        video.sort(function (a, b) { return Number(b.length) - Number(a.length); });
        if (video.length === 1) return video[0];
        if (!video.length) return null;
        var total = video.reduce(function (n, f) { return n + Number(f.length || 0); }, 0);
        return Number(video[0].length) >= total * 0.65 && Number(video[0].length) >= Number(video[1].length) * 3 ? video[0] : null;
    }
    function episodeChoices(season, episodes, movie) {
        var list = Array.isArray(episodes) ? episodes.filter(function (e) { return e && Number(e.episode_number) > 0; }) : [];
        if (!list.length) for (var i = 1; i <= Math.min(500, Number(season.episode_count) || 0); i++) list.push({ episode_number: i });
        return list.map(function (e) { return { title: e.episode_number + '. ' + (e.name || 'Серия ' + e.episode_number),
            episodeTitle: e.name || 'Серия ' + e.episode_number, episode: Number(e.episode_number),
            season: Number(season.season_number), minutes: Number(e.runtime) || Number((movie.episode_run_time || [])[0]) || 0 }; });
    }
    function resumeKey(movie) {
        if (!movie || !movie.id) return '';
        var type = movie.original_name || movie.number_of_seasons || movie.first_air_date ? 'tv' : 'movie';
        return String(movie.source || 'tmdb') + ':' + type + ':' + movie.id;
    }
    function resumeFile(files, saved) {
        if (!saved || !saved.path) return null;
        var matches = files.filter(function (file) {
            return isVideo(file) && file.path === saved.path &&
                (!saved.length || Number(file.length) === Number(saved.length));
        });
        return matches.length === 1 ? matches[0] : null;
    }
    function canResume(timeline) {
        if (!timeline) return false;
        var time = Number(timeline.time), duration = Number(timeline.duration), percent = Number(timeline.percent);
        if (!isFinite(time) || time < 0) return false;
        if (percent >= 95 || (duration > 0 && time / duration >= 0.95)) return false;
        return true;
    }
    function timeLabel(seconds) {
        var value = Math.max(0, Math.floor(Number(seconds) || 0)), minutes = Math.floor(value / 60);
        return (minutes >= 60 ? Math.floor(minutes / 60) + ':' + ('0' + minutes % 60).slice(-2) : minutes) + ':' + ('0' + value % 60).slice(-2);
    }
    return { rank: rank, pickFile: pickFile, badFormat: badFormat,
        resolution: resolution, qualityMatches: qualityMatches, episodeChoices: episodeChoices,
        resumeKey: resumeKey, resumeFile: resumeFile, canResume: canResume, timeLabel: timeLabel };
});
