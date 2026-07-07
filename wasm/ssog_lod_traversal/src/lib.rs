use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy)]
struct Rank {
    score: f64,
    screen_radius: f64,
    view_dot: f64,
}

#[derive(Clone)]
struct Selection {
    ranked_index: usize,
    lod_index: usize,
    lods: Vec<usize>,
}

struct Upgrade {
    selection_node_id: u32,
    next_index: usize,
    next_lod_index: usize,
    added_splats: i64,
    score: f64,
}

#[wasm_bindgen]
pub fn select_ssog_lod(
    node_ids: &[u32],
    depths: &[u16],
    lods: &[u16],
    counts: &[u32],
    flags: &[u8],
    lod_scales: &[f32],
    bounds: &[f32],
    budget: u32,
    camera_x: f32,
    camera_y: f32,
    camera_z: f32,
    camera_forward_x: f32,
    camera_forward_y: f32,
    camera_forward_z: f32,
    focal_pixels: f32,
    lod_range_min: f32,
    lod_range_max: f32,
    lod_underfill_limit: f32,
    force_fine_screen_ratio: f32,
    force_fine_view_dot: f32,
    cone_fov0_cos: f32,
    cone_fov_cos: f32,
    cone_foveate: f32,
    behind_foveate: f32,
) -> Vec<u32> {
    let candidate_count = [
        node_ids.len(),
        depths.len(),
        lods.len(),
        counts.len(),
        flags.len(),
        lod_scales.len(),
        bounds.len() / 6,
    ]
    .into_iter()
    .min()
    .unwrap_or(0);

    if candidate_count == 0 {
        return Vec::new();
    }

    let options = Options {
        budget: budget as i64,
        camera: [camera_x as f64, camera_y as f64, camera_z as f64],
        camera_forward: [
            camera_forward_x as f64,
            camera_forward_y as f64,
            camera_forward_z as f64,
        ],
        focal_pixels: focal_pixels as f64,
        lod_range_min: lod_range_min as f64,
        lod_range_max: lod_range_max as f64,
        lod_underfill_limit: lod_underfill_limit as f64,
        force_fine_screen_ratio: force_fine_screen_ratio as f64,
        force_fine_view_dot: force_fine_view_dot as f64,
        cone_fov0_cos: cone_fov0_cos as f64,
        cone_fov_cos: cone_fov_cos as f64,
        cone_foveate: cone_foveate as f64,
        behind_foveate: behind_foveate as f64,
    };

    let mut ranks = Vec::with_capacity(candidate_count);
    let mut groups_by_node: HashMap<u32, Vec<usize>> = HashMap::new();
    for index in 0..candidate_count {
        ranks.push(rank_candidate(index, depths, counts, flags, lod_scales, bounds, &options));
        groups_by_node.entry(node_ids[index]).or_default().push(index);
    }

    let mut selected_by_node: HashMap<u32, Selection> = HashMap::new();
    let mut selected_splats = 0i64;
    for (node_id, mut group) in groups_by_node {
        group.sort_by(|a, b| lods[*a].cmp(&lods[*b]).then_with(|| a.cmp(b)));
        let Some(coarsest_index) = group.last().copied() else {
            continue;
        };
        selected_by_node.insert(
            node_id,
            Selection {
                ranked_index: coarsest_index,
                lod_index: group.len() - 1,
                lods: group,
            },
        );
        selected_splats += counts[coarsest_index] as i64;
    }

    if selected_by_node.is_empty() {
        return Vec::new();
    }

    if selected_splats <= options.budget || options.budget <= 0 {
        selected_splats = apply_forced_fine_upgrades(
            selected_splats,
            &mut selected_by_node,
            counts,
            &ranks,
            &options,
        );
        apply_incremental_upgrades(
            selected_splats,
            &mut selected_by_node,
            depths,
            lods,
            counts,
            &ranks,
            &options,
        );
    } else {
        reduce_to_budget(&mut selected_by_node, node_ids, depths, lods, counts, &ranks, &options);
    }

    let mut selected: Vec<usize> = selected_by_node
        .values()
        .map(|selection| selection.ranked_index)
        .collect();
    selected.sort_by(|a, b| {
        node_ids[*a]
            .cmp(&node_ids[*b])
            .then_with(|| lods[*a].cmp(&lods[*b]))
            .then_with(|| a.cmp(b))
    });
    selected.into_iter().map(|index| index as u32).collect()
}

struct Options {
    budget: i64,
    camera: [f64; 3],
    camera_forward: [f64; 3],
    focal_pixels: f64,
    lod_range_min: f64,
    lod_range_max: f64,
    lod_underfill_limit: f64,
    force_fine_screen_ratio: f64,
    force_fine_view_dot: f64,
    cone_fov0_cos: f64,
    cone_fov_cos: f64,
    cone_foveate: f64,
    behind_foveate: f64,
}

fn rank_candidate(
    index: usize,
    depths: &[u16],
    counts: &[u32],
    flags: &[u8],
    lod_scales: &[f32],
    bounds: &[f32],
    options: &Options,
) -> Rank {
    let bounds_offset = index * 6;
    let min_x = bounds[bounds_offset] as f64;
    let min_y = bounds[bounds_offset + 1] as f64;
    let min_z = bounds[bounds_offset + 2] as f64;
    let max_x = bounds[bounds_offset + 3] as f64;
    let max_y = bounds[bounds_offset + 4] as f64;
    let max_z = bounds[bounds_offset + 5] as f64;
    let center_x = (min_x + max_x) * 0.5;
    let center_y = (min_y + max_y) * 0.5;
    let center_z = (min_z + max_z) * 0.5;
    let radius = 0.001f64.max(
        ((max_x - center_x).powi(2) + (max_y - center_y).powi(2) + (max_z - center_z).powi(2))
            .sqrt(),
    );
    let to_center_x = center_x - options.camera[0];
    let to_center_y = center_y - options.camera[1];
    let to_center_z = center_z - options.camera[2];
    let distance_to_center =
        0.001f64.max((to_center_x.powi(2) + to_center_y.powi(2) + to_center_z.powi(2)).sqrt());
    let distance = 0.001f64.max(distance_to_center - radius);
    let screen_radius = (radius / distance) * options.focal_pixels;
    let range = 0.000001f64.max(options.lod_range_max - options.lod_range_min);
    let normalized = 0.0f64.max((screen_radius - options.lod_range_min) / range);
    let screen_bias = if normalized <= 1.0 {
        normalized
    } else {
        1.0 + normalized.log2()
    }
    .min(4.0);
    let view_dot = 0.0f64.max(
        (to_center_x * options.camera_forward[0]
            + to_center_y * options.camera_forward[1]
            + to_center_z * options.camera_forward[2])
            / distance_to_center,
    );
    let view_bias = 0.35 + view_dot * 0.65;
    let foveation_weight = get_foveation_weight(view_dot, options);
    let distance_bias = 1.0 / distance_to_center.sqrt();
    let hysteresis = if flags[index] != 0 { 1.15 } else { 1.0 };
    let depth_bias = 1.0 + depths[index] as f64 * 0.015;
    let lod_scale = 0.01f64.max(lod_scales[index] as f64);
    Rank {
        score: screen_bias
            * view_bias
            * foveation_weight
            * distance_bias
            * (counts[index] as f64).sqrt()
            * hysteresis
            * depth_bias
            * lod_scale,
        screen_radius,
        view_dot,
    }
}

fn get_foveation_weight(view_dot: f64, options: &Options) -> f64 {
    let cone_foveate = options.cone_foveate.clamp(0.0, 1.0);
    let behind_foveate = options.behind_foveate.clamp(0.0, 1.0);
    if cone_foveate <= 0.0 && behind_foveate <= 0.0 {
        return 1.0;
    }
    if view_dot <= 0.0 {
        return 0.01f64.max(1.0 - behind_foveate);
    }
    let inner_cos = options.cone_fov0_cos.clamp(-1.0, 1.0);
    let outer_cos = options.cone_fov_cos.clamp(-1.0, 1.0);
    let high_cos = inner_cos.max(outer_cos);
    let low_cos = inner_cos.min(outer_cos);
    if view_dot >= high_cos {
        return 1.0;
    }
    if view_dot <= low_cos {
        return 0.01f64.max(1.0 - cone_foveate);
    }
    let t = (view_dot - low_cos) / 0.000001f64.max(high_cos - low_cos);
    0.01f64.max(1.0 - cone_foveate * (1.0 - t))
}

fn apply_forced_fine_upgrades(
    mut selected_splats: i64,
    selected_by_node: &mut HashMap<u32, Selection>,
    counts: &[u32],
    ranks: &[Rank],
    options: &Options,
) -> i64 {
    let mut upgrades = Vec::new();
    for (node_id, selection) in selected_by_node.iter() {
        let Some(&finest_index) = selection.lods.first() else {
            continue;
        };
        if finest_index == selection.ranked_index {
            continue;
        }
        let is_screen_dominant =
            ranks[finest_index].screen_radius >= options.lod_range_max * options.force_fine_screen_ratio;
        let is_strongly_visible = ranks[finest_index].view_dot >= options.force_fine_view_dot;
        if !is_screen_dominant || !is_strongly_visible {
            continue;
        }
        upgrades.push((
            *node_id,
            finest_index,
            counts[finest_index] as i64 - counts[selection.ranked_index] as i64,
            ranks[finest_index].screen_radius * (0.5 + ranks[finest_index].view_dot * 0.5),
        ));
    }
    upgrades.sort_by(|a, b| b.3.total_cmp(&a.3).then_with(|| a.2.cmp(&b.2)));
    for (node_id, finest_index, added_splats, _) in upgrades {
        if added_splats < 0 || selected_splats + added_splats > options.budget {
            continue;
        }
        if let Some(selection) = selected_by_node.get_mut(&node_id) {
            selection.ranked_index = finest_index;
            selection.lod_index = 0;
            selected_splats += added_splats;
        }
    }
    selected_splats
}

fn apply_incremental_upgrades(
    mut selected_splats: i64,
    selected_by_node: &mut HashMap<u32, Selection>,
    depths: &[u16],
    lods: &[u16],
    counts: &[u32],
    ranks: &[Rank],
    options: &Options,
) {
    loop {
        let mut upgrades = Vec::new();
        for (node_id, selection) in selected_by_node.iter() {
            if selection.lod_index == 0 {
                continue;
            }
            let next_lod_index = selection.lod_index - 1;
            let next_index = selection.lods[next_lod_index];
            let added_splats = counts[next_index] as i64 - counts[selection.ranked_index] as i64;
            if added_splats < 0 {
                continue;
            }
            let next_lod = lods[next_index] as f64;
            let fine_detail_bias = 1.0 + 0.65 / 1.0f64.max(next_lod + 1.0);
            let close_detail_bias = if ranks[next_index].screen_radius > options.lod_range_max {
                1.8
            } else {
                1.0
            };
            let view_detail_bias = 0.6 + ranks[next_index].view_dot * 0.4;
            let cost = 1.0f64.max(added_splats as f64).powf(0.55);
            upgrades.push(Upgrade {
                selection_node_id: *node_id,
                next_index,
                next_lod_index,
                added_splats,
                score: (ranks[next_index].score * fine_detail_bias * close_detail_bias * view_detail_bias)
                    / cost,
            });
        }
        upgrades.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| depths[b.next_index].cmp(&depths[a.next_index]))
                .then_with(|| lods[a.next_index].cmp(&lods[b.next_index]))
        });
        let Some(upgrade) = upgrades
            .into_iter()
            .find(|upgrade| selected_splats + upgrade.added_splats <= options.budget)
        else {
            break;
        };
        if let Some(selection) = selected_by_node.get_mut(&upgrade.selection_node_id) {
            selection.ranked_index = upgrade.next_index;
            selection.lod_index = upgrade.next_lod_index;
            selected_splats += upgrade.added_splats;
        } else {
            break;
        }
    }
}

fn reduce_to_budget(
    selected_by_node: &mut HashMap<u32, Selection>,
    node_ids: &[u32],
    depths: &[u16],
    lods: &[u16],
    counts: &[u32],
    ranks: &[Rank],
    options: &Options,
) {
    let mut ranked: Vec<usize> = selected_by_node
        .values()
        .map(|selection| selection.ranked_index)
        .collect();
    ranked.sort_by(|a, b| {
        ranks[*b]
            .score
            .total_cmp(&ranks[*a].score)
            .then_with(|| depths[*b].cmp(&depths[*a]))
            .then_with(|| lods[*a].cmp(&lods[*b]))
            .then_with(|| a.cmp(b))
    });

    selected_by_node.clear();
    let mut selected_nodes = HashSet::new();
    let mut selected_splats = 0i64;
    let underfill_target = (options.budget as f64 * options.lod_underfill_limit.clamp(0.0, 1.0)) as i64;
    for index in ranked {
        let count = counts[index] as i64;
        if selected_splats > 0 && selected_splats + count > options.budget && selected_splats >= underfill_target {
            continue;
        }
        let node_id = node_ids[index];
        if !selected_nodes.insert(node_id) {
            continue;
        }
        selected_by_node.insert(
            node_id,
            Selection {
                ranked_index: index,
                lod_index: 0,
                lods: vec![index],
            },
        );
        selected_splats += count;
        if selected_splats >= options.budget {
            break;
        }
    }
}
