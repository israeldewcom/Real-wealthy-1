// awards.js — LIQUIDATED Referral Awards module (v1.0)
// Mount into server.js with two lines (see bottom of file).
// ============================================================================
// Provides:
//   • 12-tier ambassador programme
//   • Confirmed-referral eligibility engine (status: 'completed' only)
//   • Claim submission with KYC gate (tier 5+) and rate-limit (3/hour)
//   • Public tiers + leaderboard endpoints
//   • Admin review workflow (claimed → under_review → approved → fulfilled)
//   • Cloudinary-ready reward images (reward_image_url + public_id)
// ============================================================================

import mongoose from 'mongoose';
import express from 'express';
import crypto from 'crypto';

export default function mountAwards(app, { auth, adminAuth, formatResponse, handleError, config }) {
    // ============================================================
    // MODELS
    // ============================================================
    const awardTierSchema = new mongoose.Schema({
        tier_number:        { type: Number, required: true, unique: true },
        slug:               { type: String, required: true, unique: true },
        title:              { type: String, required: true },
        referrals_required: { type: Number, required: true },
        reward_name:        { type: String, required: true },
        reward_description: { type: String, required: true },
        reward_category:    {
            type: String,
            enum: ['merch', 'electronics', 'lifestyle', 'vehicle', 'partnership'],
            required: true
        },
        reward_icon:        { type: String, default: '🎁' },
        reward_image_url:   { type: String, default: null },
        reward_image_public_id: { type: String, default: null },
        accent_color:       { type: String, default: '#d4af37' },
        estimated_value_ngn:{ type: Number, default: 0 },
        is_active:          { type: Boolean, default: true },
        display_order:      { type: Number, default: 0 },
        requires_admin_approval: { type: Boolean, default: true },
        terms:              { type: String, default: 'Standard programme terms apply.' }
    }, { timestamps: true });

    const awardClaimSchema = new mongoose.Schema({
        user:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        tier:               { type: mongoose.Schema.Types.ObjectId, ref: 'AwardTier', required: true },
        tier_number:        { type: Number, required: true },
        referrals_at_claim: { type: Number, required: true },
        status: {
            type: String,
            enum: ['claimed', 'under_review', 'approved', 'fulfilled', 'rejected'],
            default: 'claimed'
        },
        delivery_details: {
            full_name:    String,
            phone:        String,
            email:        String,
            address_line: String,
            city:         String,
            state:        String,
            country:      { type: String, default: 'Nigeria' },
            postal_code:  String
        },
        admin_notes:      String,
        reviewed_by:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewed_at:      Date,
        fulfilled_at:     Date,
        tracking_info:    String,
        rejection_reason: String
    }, { timestamps: true });

    awardClaimSchema.index({ user: 1, tier: 1 }, { unique: true });
    awardClaimSchema.index({ status: 1, createdAt: -1 });

    const AwardTier  = mongoose.models.AwardTier  || mongoose.model('AwardTier', awardTierSchema);
    const AwardClaim = mongoose.models.AwardClaim || mongoose.model('AwardClaim', awardClaimSchema);
    const Referral   = mongoose.models.Referral;
    const User       = mongoose.models.User;

    if (!Referral || !User) {
        console.error('❌ awards.js: Referral or User model not registered — mountAwards must be called AFTER server.js defines them.');
        return;
    }

    // ============================================================
    // TIER SEED DATA (with Cloudinary image URLs)
    // ============================================================
    // Replace each REPLACE_ME_N with your real Cloudinary secure_url,
    // e.g. https://res.cloudinary.com/<cloud>/image/upload/v1234/liquidated/awards/01-starter.jpg
    // After editing, redeploy — the auto-seed will update existing tiers on boot.
    const TIER_SEED = [
        {
            tier_number: 1, slug: 'starter', title: 'Starter',
            referrals_required: 5,
            reward_name: 'Branded T-shirt + Digital Badge',
            reward_description: 'A premium LIQUIDATED branded tee plus a permanent digital appreciation badge on your profile.',
            reward_category: 'merch', reward_icon: '🎁', accent_color: '#a8861f',
            estimated_value_ngn: 25000,
            reward_image_url: 'REPLACE_ME_1'
        },
        {
            tier_number: 2, slug: 'bronze-ambassador', title: 'Bronze Ambassador',
            referrals_required: 15,
            reward_name: 'Premium Wireless Earbuds',
            reward_description: 'High-fidelity wireless earbuds with active noise cancellation and a compact charging case.',
            reward_category: 'electronics', reward_icon: '🎧', accent_color: '#cd7f32',
            estimated_value_ngn: 85000,
            reward_image_url: 'REPLACE_ME_2'
        },
        {
            tier_number: 3, slug: 'silver-ambassador', title: 'Silver Ambassador',
            referrals_required: 30,
            reward_name: 'Smart Watch',
            reward_description: 'A modern smart watch with comprehensive health tracking and multi-day battery life.',
            reward_category: 'electronics', reward_icon: '⌚', accent_color: '#c0c0c0',
            estimated_value_ngn: 180000,
            reward_image_url: 'REPLACE_ME_3'
        },
        {
            tier_number: 4, slug: 'gold-ambassador', title: 'Gold Ambassador',
            referrals_required: 50,
            reward_name: 'Premium Backpack + VIP Badge',
            reward_description: 'A durable premium backpack with embroidered branding plus exclusive VIP status badge.',
            reward_category: 'merch', reward_icon: '🎒', accent_color: '#d4af37',
            estimated_value_ngn: 120000,
            reward_image_url: 'REPLACE_ME_4'
        },
        {
            tier_number: 5, slug: 'platinum-ambassador', title: 'Platinum Ambassador',
            referrals_required: 100,
            reward_name: 'High-Quality Smartphone',
            reward_description: 'A current-generation unlocked smartphone — colour subject to availability.',
            reward_category: 'electronics', reward_icon: '📱', accent_color: '#e5e4e2',
            estimated_value_ngn: 650000,
            reward_image_url: 'REPLACE_ME_5'
        },
        {
            tier_number: 6, slug: 'diamond-ambassador', title: 'Diamond Ambassador',
            referrals_required: 170,
            reward_name: 'Premium Tablet',
            reward_description: 'A premium tablet with stylus support — built for productivity and entertainment.',
            reward_category: 'electronics', reward_icon: '💻', accent_color: '#b9f2ff',
            estimated_value_ngn: 900000,
            reward_image_url: 'REPLACE_ME_6'
        },
        {
            tier_number: 7, slug: 'elite-ambassador', title: 'Elite Ambassador',
            referrals_required: 280,
            reward_name: 'High-End Laptop',
            reward_description: 'A high-performance laptop engineered for professional work and creative projects.',
            reward_category: 'electronics', reward_icon: '💻', accent_color: '#10b981',
            estimated_value_ngn: 1800000,
            reward_image_url: 'REPLACE_ME_7'
        },
        {
            tier_number: 8, slug: 'executive-ambassador', title: 'Executive Ambassador',
            referrals_required: 500,
            reward_name: 'Premium Smart TV',
            reward_description: 'A large-format 4K smart TV with HDR, ambient mode, and built-in streaming apps.',
            reward_category: 'electronics', reward_icon: '📺', accent_color: '#059669',
            estimated_value_ngn: 2200000,
            reward_image_url: 'REPLACE_ME_8'
        },
        {
            tier_number: 9, slug: 'crown-ambassador', title: 'Crown Ambassador',
            referrals_required: 1000,
            reward_name: 'Luxury Flagship Smartphone',
            reward_description: 'The flagship device of your choice from a curated list of premium smartphones.',
            reward_category: 'electronics', reward_icon: '💎', accent_color: '#f6d054',
            estimated_value_ngn: 1500000,
            reward_image_url: 'REPLACE_ME_9'
        },
        {
            tier_number: 10, slug: 'royal-partner', title: 'Royal Partner',
            referrals_required: 1500,
            reward_name: 'Car Contribution',
            reward_description: 'A substantial cash contribution toward a vehicle, paid directly to a verified dealer.',
            reward_category: 'vehicle', reward_icon: '🚘', accent_color: '#fbbf24',
            estimated_value_ngn: 5000000,
            reward_image_url: 'REPLACE_ME_10'
        },
        {
            tier_number: 11, slug: 'elite-partner', title: 'Elite Partner',
            referrals_required: 2000,
            reward_name: 'Luxury Vehicle + Elite Award',
            reward_description: 'Our flagship reward — a luxury vehicle plus formal recognition as an Elite Ambassador.',
            reward_category: 'vehicle', reward_icon: '🏆', accent_color: '#e9bd3d',
            estimated_value_ngn: 25000000,
            reward_image_url: 'REPLACE_ME_11'
        },
        {
            tier_number: 12, slug: 'strategic-partner', title: 'Strategic Partner',
            referrals_required: 2001,
            reward_name: 'Strategic Partnership Program',
            reward_description: 'Invitation into the Strategic Partnership Program with a dedicated account manager and priority access.',
            reward_category: 'partnership', reward_icon: '🤝', accent_color: '#34d399',
            estimated_value_ngn: 0,
            reward_image_url: 'REPLACE_ME_12'
        }
    ];

    // ============================================================
    // ELIGIBILITY ENGINE
    // ============================================================
    async function computeEligibility(userId) {
        const [user, tiers, claims] = await Promise.all([
            User.findById(userId).lean(),
            AwardTier.find({ is_active: true }).sort({ referrals_required: 1 }).lean(),
            AwardClaim.find({ user: userId }).lean()
        ]);
        if (!user) throw new Error('User not found');

        const confirmed = await Referral.countDocuments({
            referrer: userId,
            status: 'completed'
        });

        const claimedSet = new Set(claims.map(c => c.tier_number));
        const unlocked = [];
        const claimable = [];
        let nextTier = null;

        for (const t of tiers) {
            const reached = confirmed >= t.referrals_required;
            if (reached) {
                unlocked.push(t.tier_number);
                if (!claimedSet.has(t.tier_number)) claimable.push(t);
            } else if (!nextTier) {
                nextTier = {
                    ...t,
                    referrals_needed: t.referrals_required - confirmed,
                    progress_percent: Math.min(100, (confirmed / t.referrals_required) * 100)
                };
            }
        }

        // 30-day velocity for ETA
        let avg30 = 0, etaDays = null;
        if (nextTier) {
            const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const recent = await Referral.countDocuments({
                referrer: userId,
                status: 'completed',
                updatedAt: { $gte: cutoff }
            });
            avg30 = recent / 30;
            if (avg30 >= 0.5) etaDays = Math.ceil(nextTier.referrals_needed / avg30);
        }

        return {
            confirmed_referrals: confirmed,
            total_referrals: user.referral_count || 0,
            pending_referrals: await Referral.countDocuments({
                referrer: userId,
                status: { $ne: 'completed' }
            }),
            unlocked_tiers: unlocked,
            claimable_tiers: claimable,
            next_tier: nextTier,
            claims,
            referral_code: user.referral_code,
            referral_link: `${config.clientURL}/register?ref=${user.referral_code}`,
            avg_daily: avg30,
            eta_days: etaDays
        };
    }

    // ============================================================
    // ROUTES
    // ============================================================

    // ---- GET /api/awards/tiers (public) ----
    app.get('/api/awards/tiers', async (req, res) => {
        try {
            const tiers = await AwardTier.find({ is_active: true })
                .sort({ display_order: 1, referrals_required: 1 })
                .lean();
            res.set('Cache-Control', 'public, max-age=300');
            res.json(formatResponse(true, 'Awards tiers retrieved', { tiers }));
        } catch (err) {
            handleError(res, err, 'Error fetching awards tiers');
        }
    });

    // ---- GET /api/awards/status (auth) ----
    app.get('/api/awards/status', auth, async (req, res) => {
        try {
            const data = await computeEligibility(req.user._id);
            res.json(formatResponse(true, 'Awards status retrieved', data));
        } catch (err) {
            handleError(res, err, 'Error fetching awards status');
        }
    });

    // ---- POST /api/awards/claim/:tierNumber (auth) ----
    app.post('/api/awards/claim/:tierNumber', auth, async (req, res) => {
        try {
            const tierNum = Number(req.params.tierNumber);
            const { delivery_details } = req.body;

            if (!delivery_details || !delivery_details.full_name || !delivery_details.phone) {
                return res.status(400).json(formatResponse(false, 'Delivery details are required'));
            }

            const tier = await AwardTier.findOne({ tier_number: tierNum, is_active: true });
            if (!tier) return res.status(404).json(formatResponse(false, 'Tier not found'));

            const elig = await computeEligibility(req.user._id);
            if (elig.confirmed_referrals < tier.referrals_required) {
                return res.status(400).json(formatResponse(false,
                    `You need ${tier.referrals_required} confirmed referrals.`));
            }

            const existing = await AwardClaim.findOne({ user: req.user._id, tier_number: tierNum });
            if (existing) return res.status(400).json(formatResponse(false, 'Already claimed this tier'));

            // KYC gate for tiers 5+
            if (tierNum >= 5) {
                const u = await User.findById(req.user._id).lean();
                if (!u.kyc_verified) {
                    return res.status(400).json(formatResponse(false,
                        'KYC verification is required for tiers 5 and above.'));
                }
            }

            // Rate limit: max 3 claims/hour
            const recentCount = await AwardClaim.countDocuments({
                user: req.user._id,
                createdAt: { $gte: new Date(Date.now() - 3600000) }
            });
            if (recentCount >= 3) {
                return res.status(429).json(formatResponse(false, 'Rate limit: max 3 claims per hour'));
            }

            const claim = await AwardClaim.create({
                user: req.user._id,
                tier: tier._id,
                tier_number: tierNum,
                referrals_at_claim: elig.confirmed_referrals,
                status: 'claimed',
                delivery_details
            });

            res.status(201).json(formatResponse(true, 'Claim submitted successfully', { claim }));
        } catch (err) {
            handleError(res, err, 'Error submitting claim');
        }
    });

    // ---- GET /api/awards/claims (auth) ----
    app.get('/api/awards/claims', auth, async (req, res) => {
        try {
            const claims = await AwardClaim.find({ user: req.user._id })
                .sort({ createdAt: -1 })
                .lean();
            res.json(formatResponse(true, 'Claims retrieved', { claims }));
        } catch (err) {
            handleError(res, err, 'Error fetching claims');
        }
    });

    // ---- GET /api/awards/leaderboard (public) ----
    app.get('/api/awards/leaderboard', async (req, res) => {
        try {
            const results = await Referral.aggregate([
                { $match: { status: 'completed' } },
                { $group: { _id: '$referrer', confirmed: { $sum: 1 } } },
                { $sort: { confirmed: -1 } },
                { $limit: 100 },
                { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
                { $unwind: '$user' },
                {
                    $project: {
                        _id: 0,
                        userId: '$_id',
                        name: '$user.full_name',
                        confirmed: 1
                    }
                }
            ]);

            const tiers = await AwardTier.find({ is_active: true }).sort({ referrals_required: 1 }).lean();
            const tierFor = (count) => {
                let match = null;
                for (const t of tiers) { if (count >= t.referrals_required) match = t; else break; }
                return match;
            };

            const leaderboard = results.map((r, i) => ({
                rank: i + 1,
                userId: r.userId,
                name: r.name,
                confirmed: r.confirmed,
                tier: tierFor(r.confirmed)
            }));

            res.set('Cache-Control', 'public, max-age=1800');
            res.json(formatResponse(true, 'Leaderboard retrieved', { leaderboard }));
        } catch (err) {
            handleError(res, err, 'Error fetching leaderboard');
        }
    });

    // ---- Admin: list claims ----
    app.get('/api/admin/awards/claims', adminAuth, async (req, res) => {
        try {
            const { status } = req.query;
            const query = {};
            if (status) query.status = status;

            const claims = await AwardClaim.find(query)
                .populate('user', 'full_name email phone')
                .populate('tier', 'title reward_name reward_icon accent_color')
                .sort({ createdAt: -1 })
                .lean();

            res.json(formatResponse(true, 'Claims retrieved', { claims }));
        } catch (err) {
            handleError(res, err, 'Error fetching admin claims');
        }
    });

    // ---- Admin: update claim status ----
    app.post('/api/admin/awards/claims/:id/:action', adminAuth, async (req, res) => {
        try {
            const { id, action } = req.params;
            const claim = await AwardClaim.findById(id);
            if (!claim) return res.status(404).json(formatResponse(false, 'Claim not found'));

            const map = {
                review:  'under_review',
                approve: 'approved',
                fulfil:  'fulfilled',
                reject:  'rejected'
            };
            const newStatus = map[action];
            if (!newStatus) return res.status(400).json(formatResponse(false, 'Invalid action'));

            claim.status = newStatus;
            claim.reviewed_by = req.user._id;
            claim.reviewed_at = new Date();

            if (newStatus === 'fulfilled') {
                claim.fulfilled_at = new Date();
                if (req.body.tracking_info) claim.tracking_info = req.body.tracking_info;
            }
            if (newStatus === 'rejected' && req.body.reason) {
                claim.rejection_reason = req.body.reason;
            }
            if (req.body.admin_notes) claim.admin_notes = req.body.admin_notes;

            await claim.save();
            res.json(formatResponse(true, `Claim marked ${newStatus}`, { claim }));
        } catch (err) {
            handleError(res, err, 'Error updating claim');
        }
    });

    // ---- Admin: seed/re-seed tiers ----
    app.post('/api/admin/awards/seed-tiers', adminAuth, async (req, res) => {
        try {
            let created = 0, updated = 0;
            for (const t of TIER_SEED) {
                const existing = await AwardTier.findOne({ tier_number: t.tier_number });
                if (existing) {
                    await AwardTier.updateOne({ _id: existing._id }, { $set: t });
                    updated++;
                } else {
                    await AwardTier.create({ ...t, display_order: t.tier_number });
                    created++;
                }
            }
            res.json(formatResponse(true, `Seeded ${created} new, updated ${updated} tiers`));
        } catch (err) {
            handleError(res, err, 'Error seeding tiers');
        }
    });

    // Auto-seed on boot (safe — only inserts missing tiers)
    (async () => {
        try {
            let created = 0;
            for (const t of TIER_SEED) {
                const existing = await AwardTier.findOne({ tier_number: t.tier_number });
                if (!existing) {
                    await AwardTier.create({ ...t, display_order: t.tier_number });
                    created++;
                }
            }
            const total = await AwardTier.countDocuments({});
            console.log(`✅ Awards tiers verified (${total} tiers, ${created} created this boot)`);
        } catch (err) {
            console.error('⚠️ Awards tier seed error:', err.message);
        }
    })();
}
