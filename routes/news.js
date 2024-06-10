const moduleNews = require('../models/news'),
    {Router} = require('express'),
    promise = require('bluebird'),
    auth = require('../config/auth'),
    mongoose = require('mongoose'),
    tools = require('../config/tools'),
    {Engine} = require('../lib/engine');

mongoose.Promise = promise;
const recommendationEngine = new Engine();
const router = new Router();

const UPDATE_ON_ACTION = false;
const UPDATE_ON_REQUEST = true;
const MAX_LIMIT = 12;

const createSlug = title =>
    title.replace(/[^\w\s]/gi, '').trim().toLowerCase().replace(/\W+/g, '-');

const createSubtitle = article =>
    article.substring(0, 200).replace(/\r?\n|\r/g, '').trim();

// noinspection JSUnresolvedFunction
router.route('/')
//this route will get the data from the data base and respond to the request with required fields
    .get((req, res) => {
        const page = Math.max(1, parseInt(req.query.page));  //used by skip for skipping the already loaded news
        const source = req.query.source;
        if (source) {
            // noinspection JSUnresolvedFunction
            moduleNews.News
                .find({published: true, deleted: false, source: source})
                .sort({createdAt: -1})
                .skip((page - 1) * MAX_LIMIT)    //skips already loaded news
                .limit(MAX_LIMIT)   //loads 12 news from database
                .select('title source cover slug subtitle tags summary url saves views date createdAt')
                .exec()
                .then(result => {
                    if (result) res.status(200).json(result);
                    else res.status(400).json({msg: 'Internal server error.'});
                })
                .catch(err => res.status(400).json({msg: err.message}))
        } else res.status(404).json({msg: 'Source not provided.'});
    })
    //this route will post the json data generated by python to the database
    //add auth.isAuth middleware once done testing post request locally
    .post((req, res) => {
        //The res.user checks if the user is making the request. If not then the else statement is executed
        // if (!req.user) {
        //     res.status(401).json({
        //         error: 'Unauthorized'
        //     });
        // } else
        if (req.body.title && req.body.source) {
            const params = {};
            params.title = req.body.title;
            params.source = req.body.source;
            if (req.body.cover) params.cover = req.body.cover;
            if (req.body.summary) params.summary = req.body.summary;
            if (req.body.keywords) params.keywords = req.body.keywords;
            if (req.body.tags && req.body.tags.length > 0) params.tags = req.body.tags;
            if (req.body.article) {
                params.article = req.body.article;
                params.subtitle = createSubtitle(params.article);
            }
            if (req.body.url) params.url = req.body.url;
            params.slug = createSlug(params.title);
            params.published = true;
            params.deleted = false;

            const news = new moduleNews.News(params);
            news.trendingVal = tools.trendly(0, 0, tools.getTimestampFromId(news._id));

            news.save(err => {
                if (err) {
                    console.log(err.name + ':', err.message);
                    // mongoose validation failed
                    if (err.errors) {
                        let msg = '';
                        for (const e of Object.values(err.errors))
                            msg += e.message + ', ';
                        msg = msg.substring(0, msg.length - 2);
                        res.status(400).json({msg: msg});
                        // something else
                    } else
                        res.status(404).json({msg: err.message});
                } else
                    res.status(201).json({msg: 'Item created successfully.'});
            });
        } else
            res.status(401).json({msg: 'All information not provided.'});
    });

router.route('/recommendations')
    .get(auth.isAuthUser, (req, res) => {
        const page = Math.max(1, parseInt(req.query.page));
        if (UPDATE_ON_REQUEST) {
            recommendationEngine.similars.update(req.user._id)
                .then(() => recommendationEngine.suggestions.update(req.user._id))
                .then(() => recommendationEngine.suggestions.forUser(req.user._id, page, MAX_LIMIT))
                .then(suggestions => {
                    //console.log('suggestions', suggestions);
                    if (suggestions && suggestions.length > 0)
                        res.status(200).json(suggestions);
                    else
                        res.status(404).json({msg: 'No recommendations available at the moment, please try again later.'});
                })
                .catch(err => {
                    console.error(err);
                    res.status(401).json({msg: 'An error occurred, please try again later.'});
                })
        } else {
            recommendationEngine.suggestions.forUser(req.user._id, page, MAX_LIMIT)
                .then(suggestions => {
                    //console.log('suggestions', suggestions);
                    if (suggestions && suggestions.length > 0)
                        res.status(200).json(suggestions);
                    else
                        res.status(404).json({msg: 'No recommendations available at the moment, please try again later.'});

                })
                .catch(err => {
                    console.error(err);
                    res.status(401).json({msg: 'An error occurred, please try again later.'});
                })
        }
    });

router.route('/trending')
    .get((req, res) => {
        const page = Math.max(1, parseInt(req.query.page));
        moduleNews.News
            .find()
            .sort({trendingVal: -1})
            .skip((page - 1) * MAX_LIMIT)    //skips already loaded news
            .limit(MAX_LIMIT)   //loads 12 news from database
            .exec()
            .then(result => {
                if (result) res.status(200).json(result);
                else res.status(400).json({msg: 'Internal server error.'});
            })
            .catch(err => res.status(400).json({msg: err.message}))
    });

router.route('/refresh')
    .get(auth.isAuthUser, (req, res) => {
        console.log('calling refresh');
        recommendationEngine.similars.update(req.user._id)
            .then(() => recommendationEngine.suggestions.update(req.user._id))
            .then(() => res.status(201).json({msg: 'Recommendation generated...'}))
            .catch(err => console.error(err));
    });

router.route('/:id')
    .get(auth.getAuthUser, (req, res) => {
        const id = req.params.id;
        if (id) {
            moduleNews.News
            //this will find the specific news using the Id associated with it and return all fields
                .findOneAndUpdate({_id: id}, {$inc: {views: 1}}, {new: true})
                .exec()
                .then(news => {
                    //checks if result obtained and then return status 200 or return status 400
                    if (news) {
                        news.trendingVal = tools.trendly(news.saves * 3 + news.views,
                            news.ignores, tools.getTimestampFromId(news._id));
                        news.save();
                        res.status(200).json(news);
                        // update views for recommendation system
                        if (req.user) {
                            console.log('Logged in: update views for', req.user._id);
                            recommendationEngine.ignored.remove(req.user._id, id, false)
                                .then(() => recommendationEngine.views.add(req.user._id, id, UPDATE_ON_ACTION));
                        }
                    } else res.status(400).json({msg: 'Document not found, please try again later.'});
                })
                .catch(err => {
                    console.error(err);
                    res.status(400).json({msg: err.message})
                });
        }
        //if Id not found then return status 404 with error message "error: 'Id not provided'"
        else res.status(404).json({msg: 'Id not provided'});
    })
    .post((req, res) => {
        res.sendStatus(404);
    })
    .delete(auth.isAuth, (req, res) => {
        const id = req.param.id;
        if (id) {
            moduleNews.News
                .findOneAndUpdate({_id: id}, {hidden: true})
                .exec()
                .then(result => {
                    if (result) res.status(201).json({msg: 'Item created successfully'});
                    else res.sendStatus(400).json({msg: 'Internal Server error'})
                })
        } else res.sendStatus(404);
    });

router.route('/:id/save')
    .get((req, res) => {
        // noinspection JSUnresolvedVariable
        const isSaved = req.query.savecheck;
        const id = req.params.id;
        if (isSaved === 'true') {
            if (id) {
                moduleNews.News
                    .findOneAndUpdate({_id: id}, {$inc: {saves: 1}}, {new: true})
                    .exec()
                    .then(result => {
                        if (result) res.status(200).json(result);
                        else res.status(400).json({msg: 'Internal Server error'});
                    })
            } else res.status(404).json({msg: 'Id not provided'});
        } else if (isSaved === 'false') {
            if (id) {
                moduleNews.News
                    .findOneAndUpdate({_id: id}, {$inc: {saves: -1}}, {new: true})
                    .exec()
                    .then(result => {
                        if (result) res.status(200).json(result);
                        else res.status(400).json({msg: 'Internal Server error'});
                    })
            } else res.status(404).json({msg: 'Id not provided'});
        }
    });

router.route('/:id/ignore')
    .get(auth.getAuthUser, (req, res) => {
        // noinspection JSUnresolvedVariable
        const id = req.params.id;
        if (id && req.user) {
            recommendationEngine.views.remove(req.user._id, id, false)
                .then(() => recommendationEngine.ignored.add(req.user._id, id, UPDATE_ON_ACTION))
                .then(() =>
                    res.status(200).json({msg: 'Thanks, we will update your recommendation based on your feedback.'}));
        } else res.status(404).json({msg: 'Id not provided'});
    });

module.exports = router;
