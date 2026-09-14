import log from './log';
import layout from './layout-constants';

const {standardStageWidth: THUMBNAIL_WIDTH, standardStageHeight: THUMBNAIL_HEIGHT} = layout;

export const getProjectThumbnail = (vm, callback) => {
    vm.postIOData('video', {forceTransparentPreview: true});
    vm.renderer.draw();
    vm.postIOData('video', {forceTransparentPreview: false});

    const canvas = document.createElement('canvas');
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    canvas
        .getContext('2d')
        .drawImage(vm.renderer.canvas, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    callback(canvas.toDataURL());
};

export const storeProjectThumbnail = (vm, callback, onError) => {
    try {
        getProjectThumbnail(vm, callback);
    } catch (e) {
        log.error('Project thumbnail save error', e);
        onError?.(e);
    }
};
