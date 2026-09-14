// scratch-vm's own test renderer (packages/scratch-vm/test/fixtures/fake-renderer.js)
// with real layering. The upstream fake reports every sprite's layer as 'stub',
// which a saved project.json then carries as its layerOrder. Layering here
// follows scratch-render's RenderWebGL (createDrawable, destroyDrawable,
// getDrawableOrder, setDrawableOrder), without any drawing.
'use strict';

const path = require('path');

const FakeRenderer = require(path.resolve(__dirname, '../../packages/scratch-vm/test/fixtures/fake-renderer.js'));

class LayeredFakeRenderer extends FakeRenderer {
    constructor () {
        super();
        this._nextDrawableId = 0;
        this._drawList = [];
        this._groupOrdering = [];
        this._layerGroups = {};
    }

    setLayerGroupOrdering (groupOrdering) {
        this._groupOrdering = groupOrdering;
        groupOrdering.forEach((group, groupIndex) => {
            this._layerGroups[group] = {groupIndex, drawListOffset: 0};
        });
    }

    _endIndex (layerGroup) {
        if (layerGroup.groupIndex === this._groupOrdering.length - 1) return this._drawList.length;
        return this._layerGroups[this._groupOrdering[layerGroup.groupIndex + 1]].drawListOffset;
    }

    _updateOffsets (change, groupIndex) {
        for (let i = groupIndex + 1; i < this._groupOrdering.length; i++) {
            this._layerGroups[this._groupOrdering[i]].drawListOffset += change;
        }
    }

    createDrawable (group) {
        const layerGroup = this._layerGroups[group];
        if (!layerGroup) throw new Error(`Unknown layer group ${group}`);
        const id = this._nextDrawableId++;
        this._drawList.splice(this._endIndex(layerGroup), 0, id);
        this._updateOffsets(1, layerGroup.groupIndex);
        return id;
    }

    destroyDrawable (id, group) {
        const layerGroup = this._layerGroups[group];
        const index = this._drawList.indexOf(id);
        if (!layerGroup || index < layerGroup.drawListOffset || index >= this._endIndex(layerGroup)) {
            throw new Error(`Drawable ${id} is not in layer group ${group}`);
        }
        this._drawList.splice(index, 1);
        this._updateOffsets(-1, layerGroup.groupIndex);
    }

    getDrawableOrder (id) {
        return this._drawList.indexOf(id);
    }

    setDrawableOrder (id, order, group, optIsRelative, optMin) {
        const layerGroup = this._layerGroups[group];
        if (!layerGroup) throw new Error(`Unknown layer group ${group}`);
        const startIndex = layerGroup.drawListOffset;
        const endIndex = this._endIndex(layerGroup);
        const oldIndex = this._drawList.indexOf(id);
        if (oldIndex < startIndex || oldIndex >= endIndex) return null;
        if (order === 0) return oldIndex;

        this._drawList.splice(oldIndex, 1);
        let newIndex = optIsRelative ? order + oldIndex : order;
        const possibleMin = (optMin || 0) + startIndex;
        const min = (possibleMin >= startIndex && possibleMin < endIndex) ? possibleMin : startIndex;
        newIndex = Math.min(Math.max(newIndex, min), endIndex);
        this._drawList.splice(newIndex, 0, id);
        return newIndex;
    }
}

module.exports = LayeredFakeRenderer;
