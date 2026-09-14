import {getProjectThumbnail, storeProjectThumbnail} from '../../../src/lib/store-project-thumbnail';
import log from '../../../src/lib/log';

describe('getProjectThumbnail', () => {
    const THUMBNAIL_URI = 'data:image/png;base64,thumbnail';

    let drawImage;
    let thumbnailCanvas;

    const makeVM = () => ({
        postIOData: jest.fn(),
        renderer: {
            canvas: document.createElement('canvas'),
            draw: jest.fn()
        }
    });

    beforeEach(() => {
        drawImage = jest.fn();
        thumbnailCanvas = null;

        const createElement = document.createElement.bind(document);
        jest.spyOn(document, 'createElement').mockImplementation(tagName => {
            const element = createElement(tagName);
            if (tagName === 'canvas') {
                thumbnailCanvas = element;
            }
            return element;
        });
        jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            drawImage
        });
        jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
            THUMBNAIL_URI
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('scales the snapshot to 480x360 regardless of the renderer canvas size', () => {
        const callback = jest.fn();
        const vm = makeVM();

        getProjectThumbnail(vm, callback);

        expect(thumbnailCanvas.width).toBe(480);
        expect(thumbnailCanvas.height).toBe(360);
        expect(drawImage).toHaveBeenCalledWith(
            vm.renderer.canvas,
            0,
            0,
            480,
            360
        );
        expect(callback).toHaveBeenCalledWith(THUMBNAIL_URI);
    });

    test('scales synchronously while the renderer canvas contains the drawn frame', () => {
        const callback = jest.fn();
        const vm = makeVM();

        getProjectThumbnail(vm, callback);

        expect(vm.renderer.draw).toHaveReturned();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    test('draws with the video preview hidden, then restores it before scaling', () => {
        const vm = makeVM();
        vm.renderer.draw.mockImplementation(() => {
            expect(vm.postIOData.mock.calls).toEqual([
                ['video', {forceTransparentPreview: true}]
            ]);
        });

        getProjectThumbnail(vm, jest.fn());

        expect(vm.renderer.draw).toHaveBeenCalledTimes(1);
        expect(vm.postIOData.mock.calls).toEqual([
            ['video', {forceTransparentPreview: true}],
            ['video', {forceTransparentPreview: false}]
        ]);
        expect(drawImage).toHaveBeenCalled();
    });

    test('notifies onError when the renderer canvas cannot be scaled', () => {
        jest.spyOn(log, 'error').mockImplementation(() => {});
        const onError = jest.fn();
        drawImage.mockImplementation(() => {
            throw new Error('scaling failed');
        });

        storeProjectThumbnail(makeVM(), jest.fn(), onError);

        expect(onError).toHaveBeenCalled();
    });

    test('notifies onError when the snapshot cannot be taken', () => {
        jest.spyOn(log, 'error').mockImplementation(() => {});
        const onError = jest.fn();
        const vm = makeVM();
        vm.renderer.draw = () => {
            throw new Error('renderer exploded');
        };

        storeProjectThumbnail(vm, jest.fn(), onError);

        expect(onError).toHaveBeenCalled();
    });
});
