<?php
/**
 * AlcorFields HTML node.
 *
 * A node of the tree that Alcor_Fields_Html builds. Every node remembers the exact byte offsets of its start and
 * end tags in the authored markup, which is what lets rendering copy everything it does not change byte for byte.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) && ! defined( 'ALCOR_FIELDS_CLI' ) ) {
	exit;
}

/**
 * One element, text run, comment or doctype of an authored document.
 */
final class Alcor_Fields_Node {

	/**
	 * Node kind: root, element, text, comment or doctype.
	 *
	 * @var string
	 */
	public $type;

	/**
	 * Lower-case tag name (elements only).
	 *
	 * @var string
	 */
	public $name = '';

	/**
	 * Attributes in authored order, each with the byte offsets that delimit it.
	 *
	 * @var array<int, array{name: string, value: ?string, start: int, name_start: int, end: int}>
	 */
	public $attrs = array();

	/**
	 * Offset of the first byte of the node (the "<" of an element).
	 *
	 * @var int
	 */
	public $start = 0;

	/**
	 * Offset just after the start tag.
	 *
	 * @var int
	 */
	public $open_end = 0;

	/**
	 * Offset of the end tag; equals $open_end for void elements.
	 *
	 * @var int
	 */
	public $close_start = 0;

	/**
	 * Offset just after the end tag.
	 *
	 * @var int
	 */
	public $end = 0;

	/**
	 * True for void elements (img, br) and self-closed foreign elements, which have no end tag.
	 *
	 * @var bool
	 */
	public $closed_inline = false;

	/**
	 * Child nodes in document order.
	 *
	 * @var Alcor_Fields_Node[]
	 */
	public $children = array();

	/**
	 * Parent node; null for the root.
	 *
	 * @var ?Alcor_Fields_Node
	 */
	public $parent = null;

	/**
	 * Annotation data set by Alcor_Fields_Template; null on plain nodes.
	 *
	 * @var ?array
	 */
	public $af = null;

	/**
	 * True when this node or any descendant carries a data-af-* annotation.
	 *
	 * @var bool
	 */
	public $has_af = false;

	/**
	 * Creates a node of the given kind.
	 *
	 * @param string $type root, element, text, comment or doctype.
	 */
	public function __construct( $type ) {
		$this->type = $type;
	}

	/**
	 * Returns an attribute's decoded value.
	 *
	 * @param string $name Lower-case attribute name.
	 * @return ?string The value ('' for a bare attribute), or null when the attribute is absent.
	 */
	public function attr( $name ) {
		foreach ( $this->attrs as $attr ) {
			if ( $attr['name'] === $name ) {
				return $attr['value'] ?? '';
			}
		}
		return null;
	}

	/**
	 * Tells whether the element has an attribute.
	 *
	 * @param string $name Lower-case attribute name.
	 * @return bool
	 */
	public function has_attr( $name ) {
		foreach ( $this->attrs as $attr ) {
			if ( $attr['name'] === $name ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Returns the children that are elements, skipping text and comments.
	 *
	 * @return Alcor_Fields_Node[]
	 */
	public function element_children() {
		return array_values(
			array_filter(
				$this->children,
				static function ( $child ) {
					return 'element' === $child->type;
				}
			)
		);
	}
}
