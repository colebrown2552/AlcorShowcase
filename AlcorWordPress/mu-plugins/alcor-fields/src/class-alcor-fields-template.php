<?php
/**
 * AlcorFields templates: an authored HTML document whose editable parts carry data-af-* annotations.
 *
 * The annotations are the schema. A field exists exactly where the design shows it, its default is what the
 * designer wrote, and the template is refused if any default would fail its own field type, so the schema and the
 * page cannot drift apart. Rendering copies every byte it does not change; with no stored values the output equals
 * the authored file minus its data-af-* attributes.
 *
 *   data-af="key"                 element content is a field (text, or inline rich text when it has markup)
 *   data-af-type="text|inline"    force the content type
 *   data-af-attr-<name>="key"     an attribute is a field: href (url), src (image), alt, content, title, aria-label,
 *                                 width and height (number)
 *   data-af-list="key"            the element's children are repeatable items; the first item is the pattern
 *   data-af-min / data-af-max     list item bounds, or the maximum characters of a content field
 *   data-af-section="key"         a page section clients may hide (data-af-required: always shown)
 *   data-af-when="a b"            this element is removed when any of those sections is hidden (menu links)
 *   data-af-label / data-af-help  editor label and help text; data-af-optional lets content be empty
 *
 * Like the HTML and type classes this is plain PHP: it calls PHP's own json_encode() and friends instead of their
 * WordPress wrappers so that it loads outside WordPress too (define ALCOR_FIELDS_CLI).
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) && ! defined( 'ALCOR_FIELDS_CLI' ) ) {
	exit;
}

/**
 * A compiled template: its schema (fields, lists and sections), a validator for submitted values, and a renderer.
 */
final class Alcor_Fields_Template {

	const ATTR_KINDS     = array(
		'href'       => 'url',
		'src'        => 'image',
		'alt'        => 'text',
		'content'    => 'text',
		'title'      => 'text',
		'aria-label' => 'text',
		'width'      => 'number',
		'height'     => 'number',
	);
	const FLAGS          = array(
		'data-af',
		'data-af-type',
		'data-af-list',
		'data-af-min',
		'data-af-max',
		'data-af-section',
		'data-af-required',
		'data-af-when',
		'data-af-label',
		'data-af-help',
		'data-af-optional',
	);
	const SEGMENT        = '[a-z][a-z0-9_]{0,39}';
	const MULTILINE_TAGS = array( 'p', 'dd', 'blockquote', 'figcaption', 'address', 'td', 'div', 'li', 'small' );

	/**
	 * The authored markup.
	 *
	 * @var string
	 */
	public $html;

	/**
	 * SHA-256 of the authored markup. Stored with every save so a later design change can be detected.
	 *
	 * @var string
	 */
	public $sha256;

	/**
	 * Parse tree of the authored markup.
	 *
	 * @var Alcor_Fields_Node
	 */
	public $root;

	/**
	 * Section key => array of key, label, help and required, in document order.
	 *
	 * @var array<string, array>
	 */
	public $sections = array();

	/**
	 * Top-level field and list definitions in document order.
	 *
	 * @var array<string, array>
	 */
	public $fields = array();

	/**
	 * The data-af-when references seen, as pairs of section key and element, checked once parsing is done.
	 *
	 * @var array
	 */
	private $whens = array();

	/**
	 * Element id => key of the section that contains it, used to check same-page links.
	 *
	 * @var array<string, string>
	 */
	private $section_ids = array();

	/**
	 * Relative keys a list forces to inline because some of its items carry markup there.
	 *
	 * @var array<string, bool>
	 */
	private $force_inline = array();

	/**
	 * Compiles a template from markup.
	 *
	 * @param string $html  Annotated markup.
	 * @param string $label Name used in error messages.
	 * @return self
	 * @throws Alcor_Fields_Error When the markup or any annotation is invalid, or the template has no fields.
	 */
	public static function from_html( $html, $label = 'template' ) {
		$template         = new self();
		$template->html   = $html;
		$template->sha256 = hash( 'sha256', $html );
		$template->root   = Alcor_Fields_Html::parse( $html, $label );
		$template->walk( $template->root, $template->fields, null, 0, false, $label );
		$template->check_links( $label );
		if ( ! $template->fields ) {
			throw Alcor_Fields_Error::at( $label, 'template has no data-af fields' );
		}
		return $template;
	}

	/**
	 * Compiles a template from a file.
	 *
	 * @param string $file Path of the annotated HTML file.
	 * @return self
	 * @throws Alcor_Fields_Error When the file is missing or the template is invalid.
	 */
	public static function from_file( $file ) {
		if ( ! is_file( $file ) || ! is_readable( $file ) ) {
			throw Alcor_Fields_Error::at( basename( (string) $file ), 'template file is missing' );
		}
		return self::from_html( (string) file_get_contents( $file ), basename( dirname( $file ) ) . '/' . basename( $file ) );
	}

	/* ------------------------------------------------------------------ schema */

	/**
	 * Visits the element children of a node.
	 *
	 * @param Alcor_Fields_Node $node    Parent node.
	 * @param array             $defs    Definitions collected so far; extended in place.
	 * @param ?string           $section Key of the enclosing section, if any.
	 * @param int               $depth   List nesting depth.
	 * @param bool              $in_item True inside a list item.
	 * @param string            $label   Name used in error messages.
	 * @return void
	 */
	private function walk( Alcor_Fields_Node $node, array &$defs, $section, $depth, $in_item, $label ) {
		foreach ( $node->children as $child ) {
			if ( 'element' === $child->type ) {
				$this->visit( $child, $defs, $section, $depth, $in_item, $label );
			}
		}
	}

	/**
	 * Collects the data-af-* attributes of an element.
	 *
	 * @param Alcor_Fields_Node $el    Element.
	 * @param string            $label Name used in error messages.
	 * @return array<string, string> Annotation name => value.
	 * @throws Alcor_Fields_Error On an annotation this version does not know. A typo must not silently make a field vanish.
	 */
	private function annotations( Alcor_Fields_Node $el, $label ) {
		$ann = array();
		foreach ( $el->attrs as $attr ) {
			if ( 0 !== strpos( $attr['name'], 'data-af' ) ) {
				continue;
			}
			if ( ! in_array( $attr['name'], self::FLAGS, true ) && 0 !== strpos( $attr['name'], 'data-af-attr-' ) ) {
				throw $this->fail( $el, $label, 'unknown annotation ' . $attr['name'] );
			}
			$ann[ $attr['name'] ] = (string) $attr['value'];
		}
		return $ann;
	}

	/**
	 * Turns one element's annotations into section, field and list definitions, then descends into it.
	 *
	 * @param Alcor_Fields_Node $el      Element.
	 * @param array             $defs    Definitions of the enclosing scope; extended in place.
	 * @param ?string           $section Key of the enclosing section, if any.
	 * @param int               $depth   List nesting depth.
	 * @param bool              $in_item True inside a list item.
	 * @param string            $label   Name used in error messages.
	 * @return void
	 * @throws Alcor_Fields_Error On any annotation that cannot be honoured exactly.
	 */
	private function visit( Alcor_Fields_Node $el, array &$defs, $section, $depth, $in_item, $label ) {
		$ann = $this->annotations( $el, $label );
		if ( ! $ann ) {
			if ( $el->has_attr( 'id' ) && null !== $section ) {
				$this->section_ids[ $el->attr( 'id' ) ] = $section;
			}
			$this->walk( $el, $defs, $section, $depth, $in_item, $label );
			return;
		}
		$af = array(
			'content' => null,
			'attrs'   => array(),
			'list'    => null,
			'section' => null,
			'when'    => null,
		);
		for ( $n = $el; null !== $n; $n = $n->parent ) {
			$n->has_af = true;
		}

		if ( isset( $ann['data-af-section'] ) ) {
			if ( $in_item || null !== $section ) {
				throw $this->fail( $el, $label, 'a section cannot sit inside another section or a list' );
			}
			$key = $this->key( $ann['data-af-section'], $el, $label, true );
			if ( isset( $this->sections[ $key ] ) ) {
				throw $this->fail( $el, $label, 'duplicate section ' . $key );
			}
			$this->sections[ $key ] = array(
				'key'      => $key,
				'label'    => $ann['data-af-label'] ?? self::humanize( $key ),
				'help'     => $ann['data-af-help'] ?? '',
				'required' => isset( $ann['data-af-required'] ),
			);
			$section        = $key;
			$af['section']  = $key;
			if ( isset( $ann['data-af'] ) || isset( $ann['data-af-list'] ) ) {
				throw $this->fail( $el, $label, 'annotate a field inside the section, not the section element' );
			}
		}
		if ( $el->has_attr( 'id' ) && null !== $section ) {
			$this->section_ids[ $el->attr( 'id' ) ] = $section;
		}
		if ( isset( $ann['data-af-when'] ) ) {
			if ( $in_item ) {
				throw $this->fail( $el, $label, 'data-af-when cannot sit inside a list item' );
			}
			$af['when'] = array();
			foreach ( preg_split( '/\s+/', trim( $ann['data-af-when'] ) ) as $when ) {
				$af['when'][]  = $this->key( $when, $el, $label, true );
				$this->whens[] = array( $when, $el );
			}
		}
		foreach ( $ann as $name => $value ) {
			if ( 0 !== strpos( $name, 'data-af-attr-' ) ) {
				continue;
			}
			$attr = substr( $name, strlen( 'data-af-attr-' ) );
			if ( ! isset( self::ATTR_KINDS[ $attr ] ) ) {
				throw $this->fail( $el, $label, 'attribute ' . $attr . ' cannot be a field' );
			}
			if ( ! $el->has_attr( $attr ) ) {
				throw $this->fail( $el, $label, 'data-af-attr-' . $attr . ' needs an authored ' . $attr . ' attribute' );
			}
			$key  = $this->key( $value, $el, $label, ! $in_item );
			$kind = self::ATTR_KINDS[ $attr ];
			$this->add(
				$defs,
				$key,
				array(
					'type'      => 'field',
					'key'       => $key,
					'kind'      => $kind,
					'attr'      => $attr,
					'element'   => $el->name,
					'label'     => self::humanize( $key ),
					'help'      => '',
					'section'   => $section,
					'max'       => in_array( $kind, array( 'url', 'image' ), true )
						? 500
						: ( 'number' === $kind ? 5 : max( 'content' === $attr ? 320 : 300, (int) ceil( Alcor_Fields_Types::length( (string) $el->attr( $attr ) ) * 1.5 ) ) ),
					'required'  => 'alt' !== $attr,
					'multiline' => false,
					'default'   => (string) $el->attr( $attr ),
				),
				$el,
				$label
			);
			$af['attrs'][ $attr ] = $key;
		}
		if ( isset( $ann['data-af'] ) ) {
			if ( isset( $ann['data-af-list'] ) ) {
				throw $this->fail( $el, $label, 'an element is either a field or a list, not both' );
			}
			if ( $el->closed_inline || ( in_array( $el->name, Alcor_Fields_Html::RAW_TEXT, true ) && 'title' !== $el->name ) ) {
				throw $this->fail( $el, $label, '<' . $el->name . '> content cannot be a field' );
			}
			if ( $this->contains_annotations( $el ) ) {
				throw $this->fail( $el, $label, 'a field element cannot contain other annotations' );
			}
			$key        = $this->key( $ann['data-af'], $el, $label, ! $in_item );
			$inner      = Alcor_Fields_Html::inner( $this->html, $el );
			$has_markup = (bool) array_filter(
				$el->children,
				static function ( $c ) {
					return 'text' !== $c->type;
				}
			);
			$kind       = $ann['data-af-type'] ?? ( ( $has_markup || isset( $this->force_inline[ $key ] ) ) ? 'inline' : 'text' );
			if ( ! in_array( $kind, array( 'text', 'inline' ), true ) ) {
				throw $this->fail( $el, $label, 'data-af-type must be text or inline' );
			}
			if ( 'text' === $kind && $has_markup ) {
				throw $this->fail( $el, $label, 'content has markup; a text field would lose it' );
			}
			$default  = 'text' === $kind ? Alcor_Fields_Html::decode( $inner ) : $inner;
			$visible  = 'text' === $kind ? $default : Alcor_Fields_Html::decode( strip_tags( $inner ) );
			$max      = isset( $ann['data-af-max'] ) ? $this->int( $ann['data-af-max'], $el, $label, 1, 20000 )
				: min( 4000, max( 40, (int) ceil( Alcor_Fields_Types::length( trim( $visible ) ) * 2.5 ) ) );
			$no_links = false;
			for ( $n = $el; null !== $n; $n = $n->parent ) {
				if ( 'element' === $n->type && in_array( $n->name, array( 'a', 'button' ), true ) ) {
					$no_links = true;
				}
			}
			$this->add(
				$defs,
				$key,
				array(
					'type'      => 'field',
					'key'       => $key,
					'kind'      => $kind,
					'attr'      => null,
					'element'   => $el->name,
					'classes'   => 'inline' === $kind ? Alcor_Fields_Types::inline_classes( $inner ) : array(),
					'no_links'  => $no_links,
					'label'     => $ann['data-af-label'] ?? self::humanize( $key ),
					'help'      => $ann['data-af-help'] ?? '',
					'section'   => $section,
					'max'       => $max,
					'required'  => ! isset( $ann['data-af-optional'] ),
					'multiline' => 'inline' === $kind || false !== strpos( $default, "\n" ) || in_array( $el->name, self::MULTILINE_TAGS, true ),
					'default'   => $default,
				),
				$el,
				$label
			);
			$af['content'] = $key;
		}
		if ( isset( $ann['data-af-list'] ) ) {
			if ( $depth >= 2 ) {
				throw $this->fail( $el, $label, 'lists nest at most two deep' );
			}
			$key   = $this->key( $ann['data-af-list'], $el, $label, ! $in_item );
			$items = $el->element_children();
			if ( ! $items ) {
				throw $this->fail( $el, $label, 'a list needs at least one authored item' );
			}
			foreach ( $el->children as $child ) {
				if ( 'element' === $child->type ) {
					continue;
				}
				if ( 'text' !== $child->type || '' !== trim( Alcor_Fields_Html::slice( $this->html, $child->start, $child->end ) ) ) {
					throw $this->fail( $el, $label, 'a list holds only its items (no loose text or comments)' );
				}
			}
			// Items may differ in which fields carry markup (one address has a <br>): those fields are inline in all.
			$force = array();
			for ( $pass = 0; $pass < 2; $pass++ ) {
				$saved              = $this->force_inline;
				$this->force_inline = $force;
				$all_defs           = array();
				foreach ( $items as $item ) {
					$row_defs = array();
					$this->visit( $item, $row_defs, $section, $depth + 1, true, $label );
					$all_defs[] = $row_defs;
				}
				$this->force_inline = $saved;
				$kinds              = array();
				foreach ( $all_defs as $row_defs ) {
					foreach ( $row_defs as $k => $d ) {
						if ( 'field' === $d['type'] && null === $d['attr'] ) {
							$kinds[ $k ][ $d['kind'] ] = true;
						}
					}
				}
				$mixed = array_filter(
					$kinds,
					static function ( $set ) {
						return count( $set ) > 1;
					}
				);
				if ( ! $mixed || 1 === $pass ) {
					break;
				}
				$force = array_fill_keys( array_keys( $mixed ), true );
			}
			$item_defs = null;
			$rows      = array();
			$shape     = null;
			foreach ( $items as $index => $item ) {
				$row_defs = $all_defs[ $index ];
				if ( ! $row_defs ) {
					throw $this->fail( $item, $label, 'list item has no fields' );
				}
				$signature = self::signature( $row_defs );
				$skeleton  = $this->skeleton( $item );
				if ( preg_match( '/ id=/', $skeleton ) ) {
					throw $this->fail( $item, $label, 'list items cannot carry id attributes (new items would repeat them)' );
				}
				if ( null === $item_defs ) {
					$item_defs = $row_defs;
					$shape     = array( $signature, $skeleton );
				} elseif ( array( $signature, $skeleton ) !== $shape ) {
					throw $this->fail( $item, $label, 'list item ' . ( $index + 1 ) . ' of ' . $key . ' differs from the first item outside its fields' );
				} else {
					// One rule for every item: the longest authored length, every class any item used.
					$item_defs = self::merge_defs( $item_defs, $row_defs );
				}
				$rows[] = self::defaults( $row_defs );
			}
			$min = isset( $ann['data-af-min'] ) ? $this->int( $ann['data-af-min'], $el, $label, 0, 200 ) : 1;
			$max = isset( $ann['data-af-max'] ) ? $this->int( $ann['data-af-max'], $el, $label, 1, 200 ) : max( 12, count( $items ) * 2 );
			if ( $min > $max || count( $items ) < $min || count( $items ) > $max ) {
				throw $this->fail( $el, $label, 'authored items fall outside data-af-min/max' );
			}
			$this->add(
				$defs,
				$key,
				array(
					'type'    => 'list',
					'key'     => $key,
					'element' => $el->name,
					'label'   => $ann['data-af-label'] ?? self::humanize( $key ),
					'help'    => $ann['data-af-help'] ?? '',
					'section' => $section,
					'min'     => $min,
					'max'     => $max,
					'item'    => $item_defs,
					'default' => $rows,
				),
				$el,
				$label
			);
			$af['list'] = $key;
			$el->af     = $af;
			return;
		}
		$el->af = $af;
		if ( null === $af['content'] ) {
			$this->walk( $el, $defs, $section, $depth, $in_item, $label );
		}
	}

	/**
	 * Registers a definition, checking that the authored default passes its own field type.
	 *
	 * @param array             $defs  Definitions of the enclosing scope; extended in place.
	 * @param string            $key   Field key.
	 * @param array             $def   The definition.
	 * @param Alcor_Fields_Node $el    Element the definition came from.
	 * @param string            $label Name used in error messages.
	 * @return void
	 * @throws Alcor_Fields_Error On a duplicate key or an invalid authored default.
	 */
	private function add( array &$defs, $key, array $def, Alcor_Fields_Node $el, $label ) {
		if ( isset( $defs[ $key ] ) ) {
			throw $this->fail( $el, $label, 'duplicate field ' . $key );
		}
		if ( 'field' === $def['type'] ) {
			try {
				$def['default'] = Alcor_Fields_Types::canonical( $def['default'], $def, $key, array() );
			} catch ( Alcor_Fields_Error $e ) {
				throw $this->fail( $el, $label, 'authored default of ' . $key . ' is not a valid ' . $def['kind'] . ' value (' . $e->getMessage() . ')' );
			}
		}
		$defs[ $key ] = $def;
	}

	/**
	 * Tells whether any descendant of an element carries an annotation.
	 *
	 * @param Alcor_Fields_Node $el Element.
	 * @return bool
	 */
	private function contains_annotations( Alcor_Fields_Node $el ) {
		foreach ( $el->children as $child ) {
			if ( 'element' !== $child->type ) {
				continue;
			}
			foreach ( $child->attrs as $attr ) {
				if ( 0 === strpos( $attr['name'], 'data-af' ) ) {
					return true;
				}
			}
			if ( $this->contains_annotations( $child ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Describes an item's markup with its field contents and bound attribute values blanked.
	 *
	 * List items must match this string exactly, so that "add an item" can copy the first item and every row
	 * renders with the same shape.
	 *
	 * @param Alcor_Fields_Node $el List item (or a descendant of one).
	 * @return string
	 */
	private function skeleton( Alcor_Fields_Node $el ) {
		$bound   = array();
		$content = false;
		$list    = false;
		foreach ( $el->attrs as $attr ) {
			if ( 0 === strpos( $attr['name'], 'data-af-attr-' ) ) {
				$bound[] = substr( $attr['name'], strlen( 'data-af-attr-' ) );
			}
			if ( 'data-af' === $attr['name'] ) {
				$content = true;
			}
			if ( 'data-af-list' === $attr['name'] ) {
				$list = true;
			}
		}
		$out = '<' . $el->name;
		foreach ( $el->attrs as $attr ) {
			if ( 0 === strpos( $attr['name'], 'data-af' ) ) {
				continue;
			}
			$out .= ' ' . $attr['name'] . ( in_array( $attr['name'], $bound, true ) ? '=*' : '=' . json_encode( $attr['value'] ) );
		}
		$out .= '>';
		if ( $content ) {
			return $out . '{field}';
		}
		$children = $list ? array_slice( $el->element_children(), 0, 1 ) : $el->children;
		foreach ( $children as $child ) {
			if ( 'element' === $child->type ) {
				$out .= $this->skeleton( $child );
			} elseif ( 'text' === $child->type ) {
				$text = trim( preg_replace( '/\s+/', ' ', Alcor_Fields_Html::slice( $this->html, $child->start, $child->end ) ) );
				if ( '' !== $text ) {
					$out .= json_encode( $text );
				}
			} else {
				$out .= Alcor_Fields_Html::slice( $this->html, $child->start, $child->end );
			}
		}
		return $out . ( $list ? '[*]' : '' ) . '</' . $el->name . '>';
	}

	/**
	 * Summarises a set of definitions as kind, attribute and required flag per key (lists recurse).
	 *
	 * @param array $defs Definitions.
	 * @return array
	 */
	private static function signature( array $defs ) {
		$out = array();
		foreach ( $defs as $key => $def ) {
			$out[ $key ] = 'list' === $def['type'] ? array( 'list', self::signature( $def['item'] ) ) : array( $def['kind'], $def['attr'], $def['required'] );
		}
		return $out;
	}

	/**
	 * Merges the definitions of two list items into one rule that fits both.
	 *
	 * @param array $a Definitions of the items merged so far.
	 * @param array $b Definitions of the next item.
	 * @return array
	 */
	private static function merge_defs( array $a, array $b ) {
		foreach ( $a as $key => $def ) {
			$other = $b[ $key ];
			if ( 'list' === $def['type'] ) {
				$def['min']  = min( $def['min'], $other['min'] );
				$def['max']  = max( $def['max'], $other['max'] );
				$def['item'] = self::merge_defs( $def['item'], $other['item'] );
			} else {
				$def['max']       = max( $def['max'], $other['max'] );
				$def['multiline'] = $def['multiline'] || $other['multiline'];
				$classes          = array_values( array_unique( array_merge( $def['classes'] ?? array(), $other['classes'] ?? array() ) ) );
				sort( $classes );
				$def['classes'] = $classes;
			}
			$a[ $key ] = $def;
		}
		return $a;
	}

	/**
	 * Collects the authored default of every definition.
	 *
	 * @param array $defs Definitions.
	 * @return array Key => default.
	 */
	private static function defaults( array $defs ) {
		$out = array();
		foreach ( $defs as $key => $def ) {
			$out[ $key ] = $def['default'];
		}
		return $out;
	}

	/**
	 * Checks the cross-references that are only known once the whole document has been read.
	 *
	 * Every same-page link to a section a client may hide must disappear with it (data-af-when) or live inside it,
	 * or hiding the section would leave a dead link behind.
	 *
	 * @param string $label Name used in error messages.
	 * @return void
	 * @throws Alcor_Fields_Error On an unknown section name or a link that would break.
	 */
	private function check_links( $label ) {
		foreach ( $this->whens as $when ) {
			if ( ! isset( $this->sections[ $when[0] ] ) ) {
				throw $this->fail( $when[1], $label, 'data-af-when names unknown section ' . $when[0] );
			}
		}
		$this->check_anchor_links( $this->root, null, array(), $label );
	}

	/**
	 * Walks the tree looking for same-page links to hideable sections.
	 *
	 * @param Alcor_Fields_Node $node    Node to inspect.
	 * @param ?string           $section Key of the enclosing section, if any.
	 * @param string[]          $whens   Sections whose hiding removes the current element.
	 * @param string            $label   Name used in error messages.
	 * @return void
	 * @throws Alcor_Fields_Error When a link would break if its target section were hidden.
	 */
	private function check_anchor_links( Alcor_Fields_Node $node, $section, array $whens, $label ) {
		foreach ( $node->children as $child ) {
			if ( 'element' !== $child->type ) {
				continue;
			}
			$here_section = $section;
			$here_whens   = $whens;
			if ( $child->af ) {
				if ( $child->af['section'] ) {
					$here_section = $child->af['section'];
				}
				if ( $child->af['when'] ) {
					$here_whens = array_merge( $here_whens, $child->af['when'] );
				}
			}
			$href = 'a' === $child->name ? $child->attr( 'href' ) : null;
			if ( is_string( $href ) && strlen( $href ) > 1 && '#' === $href[0] && empty( $child->af['attrs']['href'] ) ) {
				$target = $this->section_ids[ substr( $href, 1 ) ] ?? null;
				if ( null !== $target && empty( $this->sections[ $target ]['required'] ) && $target !== $here_section && ! in_array( $target, $here_whens, true ) ) {
					throw $this->fail( $child, $label, 'link to ' . $href . ' would break when section ' . $target . ' is hidden; add data-af-when="' . $target . '" to it or an ancestor' );
				}
			}
			// Authored links inside a rich-text default count too: the field (or an ancestor) carries the data-af-when.
			$this->check_anchor_links( $child, $here_section, $here_whens, $label );
		}
	}

	/**
	 * Validates a field, list or section key.
	 *
	 * @param string            $value     The key as authored.
	 * @param Alcor_Fields_Node $el        Element, for the error position.
	 * @param string            $label     Name used in error messages.
	 * @param bool              $top_level True outside list items.
	 * @return string The key, unchanged.
	 * @throws Alcor_Fields_Error When the key is not lower-case segments joined by dots.
	 */
	private function key( $value, Alcor_Fields_Node $el, $label, $top_level ) {
		$pattern = '/^' . self::SEGMENT . '(?:\.' . self::SEGMENT . '){0,3}$/';
		if ( ! preg_match( $pattern, $value ) ) {
			throw $this->fail( $el, $label, 'invalid key "' . $value . '" (lowercase letters, digits, _ and dots)' );
		}
		return $value;
	}

	/**
	 * Validates a whole-number annotation.
	 *
	 * @param string            $value Value as authored.
	 * @param Alcor_Fields_Node $el    Element, for the error position.
	 * @param string            $label Name used in error messages.
	 * @param int               $min   Smallest allowed value.
	 * @param int               $max   Largest allowed value.
	 * @return int
	 * @throws Alcor_Fields_Error When the value is not a whole number in range.
	 */
	private function int( $value, Alcor_Fields_Node $el, $label, $min, $max ) {
		if ( ! preg_match( '/^[0-9]{1,5}$/', $value ) || (int) $value < $min || (int) $value > $max ) {
			throw $this->fail( $el, $label, 'expected a whole number from ' . $min . ' to ' . $max );
		}
		return (int) $value;
	}

	/**
	 * Builds an error positioned at an element's line.
	 *
	 * @param Alcor_Fields_Node $el      Element.
	 * @param string            $label   Name used in error messages.
	 * @param string            $message What is wrong.
	 * @return Alcor_Fields_Error
	 */
	private function fail( Alcor_Fields_Node $el, $label, $message ) {
		return Alcor_Fields_Error::at( $label . ' line ' . Alcor_Fields_Html::line( $this->html, $el->start ), $message );
	}

	/**
	 * Turns a key into a label: the last dotted segment, underscores as spaces, first letter capitalised.
	 *
	 * @param string $key Field key.
	 * @return string
	 */
	public static function humanize( $key ) {
		$parts = explode( '.', $key );
		$last  = str_replace( '_', ' ', end( $parts ) );
		return ucfirst( $last );
	}

	/* ------------------------------------------------------------------ values */

	/**
	 * Validates a submitted document. Returns the sparse canonical form: only values that differ from the
	 * authored defaults are kept, so an untouched field keeps following the template.
	 *
	 * @param array $doc ['values' => [key => value|rows], 'hidden' => [section keys]].
	 * @param array $env Site facts; see Alcor_Fields_Types::canonical().
	 * @return array{values: array, hidden: string[]}
	 * @throws Alcor_Fields_Error With every problem found, not just the first.
	 */
	public function validate( $doc, array $env = array() ) {
		$dropped = array();
		return $this->clean( $doc, $env, true, $dropped );
	}

	/**
	 * Reads stored data against the current template, which may have changed since it was saved (a design update).
	 *
	 * Nothing a client wrote is thrown away that can still be shown: list rows are kept and repaired (a field the
	 * design added gets its authored default), a field retyped between plain and inline text is converted when
	 * that is lossless, and only values the design no longer has or accepts fall back to the authored default.
	 * Every fallback is reported in 'dropped'. The 'signatures' a save recorded tell which fields changed type
	 * since then.
	 *
	 * @param mixed $doc A stored document.
	 * @param array $env Site facts; see Alcor_Fields_Types::canonical().
	 * @return array{values: array, hidden: string[], dropped: array}
	 */
	public function validate_stored( $doc, array $env = array() ) {
		$dropped = array();
		$clean   = $this->clean( is_array( $doc ) ? $doc : array(), $env, false, $dropped );
		return $clean + array( 'dropped' => $dropped );
	}

	/**
	 * Shared body of validate() and validate_stored().
	 *
	 * Strict mode refuses the document and reports every problem. Lenient mode (stored data) repairs what it can
	 * and records the rest in $dropped.
	 *
	 * @param mixed $doc     The document.
	 * @param array $env     Site facts.
	 * @param bool  $strict  True to refuse bad input.
	 * @param array $dropped Receives the problems that lenient mode worked around.
	 * @return array{values: array, hidden: string[]}
	 * @throws Alcor_Fields_Error In strict mode, when anything is wrong.
	 */
	private function clean( $doc, array $env, $strict, array &$dropped ) {
		if ( ! is_array( $doc ) ) {
			throw Alcor_Fields_Error::at( 'document', 'must be an object' );
		}
		$errors = array();
		foreach ( array_keys( $doc ) as $name ) {
			if ( ! in_array( $name, array( 'values', 'hidden' ), true ) && $strict ) {
				$errors[] = array(
					'path'    => (string) $name,
					'message' => 'unknown document key',
				);
			}
		}
		$values = $doc['values'] ?? array();
		if ( ! is_array( $values ) || ( $values && array_is_list( $values ) ) ) {
			if ( $strict ) {
				throw Alcor_Fields_Error::at( 'values', 'must be an object of field keys' );
			}
			$dropped[] = array(
				'path'    => 'values',
				'message' => 'must be an object of field keys',
			);
			$values    = array();
		}
		$sigs = ! $strict && isset( $doc['signatures'] ) && is_array( $doc['signatures'] ) ? $doc['signatures'] : null;
		$out  = array();
		foreach ( $values as $key => $value ) {
			$key = (string) $key;
			if ( ! isset( $this->fields[ $key ] ) ) {
				if ( $strict ) {
					$errors[] = array(
						'path'    => $key,
						'message' => 'no such field in this template',
					);
				} else {
					$dropped[] = array(
						'path'    => $key,
						'message' => 'no such field in this template',
					);
				}
				continue;
			}
			if ( ! $strict ) {
				$repaired = $this->repair( $this->fields[ $key ], $value, $key, $key, $env, $sigs, $dropped );
				if ( null !== $repaired && $repaired !== $this->fields[ $key ]['default'] ) {
					$out[ $key ] = $repaired;
				}
				continue;
			}
			try {
				$clean = self::canonical_def( $this->fields[ $key ], $value, $key, $env );
				if ( $clean !== $this->fields[ $key ]['default'] ) {
					$out[ $key ] = $clean;
				}
			} catch ( Alcor_Fields_Error $e ) {
				if ( $strict ) {
					$errors = array_merge( $errors, $e->errors );
				} else {
					$dropped = array_merge( $dropped, $e->errors );
				}
			}
		}
		$hidden       = $doc['hidden'] ?? array();
		$clean_hidden = array();
		if ( ! is_array( $hidden ) || ! array_is_list( $hidden ) ) {
			$errors[] = array(
				'path'    => 'hidden',
				'message' => 'must be a list of section keys',
			);
			$hidden   = array();
		}
		foreach ( $hidden as $index => $section ) {
			if ( ! is_string( $section ) || ! isset( $this->sections[ $section ] ) ) {
				$errors[] = array(
					'path'    => 'hidden.' . $index,
					'message' => 'no such section',
				);
				continue;
			}
			if ( $this->sections[ $section ]['required'] ) {
				$errors[] = array(
					'path'    => 'hidden.' . $index,
					'message' => 'section ' . $section . ' cannot be hidden',
				);
				continue;
			}
			$clean_hidden[ $section ] = true;
		}
		if ( $errors && $strict ) {
			throw Alcor_Fields_Error::many( $errors );
		}
		$dropped = array_merge( $dropped, $errors );
		$ordered = array();
		foreach ( array_keys( $this->sections ) as $section ) {
			if ( isset( $clean_hidden[ $section ] ) ) {
				$ordered[] = $section;
			}
		}
		return array(
			'values' => $out,
			'hidden' => $ordered,
		);
	}

	/**
	 * Returns the type name of a definition: 'list' or the field kind.
	 *
	 * @param array $def A definition.
	 * @return string
	 */
	private static function kind_sig( array $def ) {
		return 'list' === $def['type'] ? 'list' : $def['kind'];
	}

	/**
	 * Lists the type of every field path, saved with content so a later design change can be told apart from bad data.
	 *
	 * Paths are "key" for a top-level field and "list[].field" for a field in a list item.
	 *
	 * @return array<string, string> Field path => kind ('text', 'inline', ..., 'list').
	 */
	public function signatures() {
		$out  = array();
		$walk = static function ( array $defs, $prefix ) use ( &$walk, &$out ) {
			foreach ( $defs as $key => $def ) {
				$path         = '' === $prefix ? $key : $prefix . '[].' . $key;
				$out[ $path ] = self::kind_sig( $def );
				if ( 'list' === $def['type'] ) {
					$walk( $def['item'], $path );
				}
			}
		};
		$walk( $this->fields, '' );
		return $out;
	}

	/**
	 * Lenient form of canonical_def() for stored data.
	 *
	 * @param array   $def     Field or list definition.
	 * @param mixed   $value   The stored value.
	 * @param string  $path    Human path for the report.
	 * @param string  $sig     Signature path, as signatures() spells it.
	 * @param array   $env     Site facts.
	 * @param ?array  $sigs    The signatures recorded when the value was saved.
	 * @param array   $dropped Receives what could not be kept.
	 * @return mixed The repaired value; null means "use the authored default" (and has been reported).
	 */
	private function repair( array $def, $value, $path, $sig, array $env, $sigs, array &$dropped ) {
		$now = self::kind_sig( $def );
		$was = is_array( $sigs ) && isset( $sigs[ $sig ] ) && is_string( $sigs[ $sig ] ) ? $sigs[ $sig ] : $now;
		if ( 'list' === $def['type'] ) {
			if ( 'list' !== $was || ! is_array( $value ) || ( $value && ! array_is_list( $value ) ) ) {
				$dropped[] = array(
					'path'    => $path,
					'message' => 'no longer fits this list; the original items are shown',
				);
				return null;
			}
			$rows = array();
			foreach ( $value as $index => $row ) {
				$row_path = $path . '[' . $index . ']';
				if ( ! is_array( $row ) || ( $row && array_is_list( $row ) ) ) {
					$dropped[] = array(
						'path'    => $row_path,
						'message' => 'not an item; left out',
					);
					continue;
				}
				foreach ( array_keys( $row ) as $name ) {
					if ( ! isset( $def['item'][ (string) $name ] ) ) {
						$dropped[] = array(
							'path'    => $row_path . '.' . $name,
							'message' => 'the design no longer has this field',
						);
					}
				}
				$clean = array();
				foreach ( $def['item'] as $key => $item ) {
					if ( ! array_key_exists( $key, $row ) ) {
						// A field the design added since this was saved.
						$clean[ $key ] = $item['default'];
						continue;
					}
					$repaired      = $this->repair( $item, $row[ $key ], $row_path . '.' . $key, $sig . '[].' . $key, $env, $sigs, $dropped );
					$clean[ $key ] = $repaired ?? $item['default'];
				}
				$rows[] = $clean;
			}
			if ( count( $rows ) > $def['max'] ) {
				$dropped[] = array(
					'path'    => $path,
					'message' => 'the design now allows ' . $def['max'] . ' items; the rest are not shown',
				);
				$rows      = array_slice( $rows, 0, $def['max'] );
			}
			for ( $i = count( $rows ); $i < $def['min']; $i++ ) {
				$rows[] = $def['default'][ $i ] ?? $def['default'][0];
			}
			return $rows;
		}
		if ( $was !== $now ) {
			// Plain <-> inline text converts losslessly when there is no markup to lose; anything else falls back.
			if ( 'inline' === $was && 'text' === $now && is_string( $value ) && false === strpos( $value, '<' ) ) {
				$value = Alcor_Fields_Html::decode( $value );
			} elseif ( 'text' === $was && 'inline' === $now && is_string( $value ) ) {
				$value = Alcor_Fields_Html::esc_text( $value );
			} else {
				$dropped[] = array(
					'path'    => $path,
					'message' => 'the design changed this field from ' . $was . ' to ' . $now . '; the original text is shown',
				);
				return null;
			}
		}
		try {
			return Alcor_Fields_Types::canonical( $value, $def, $path, $env );
		} catch ( Alcor_Fields_Error $e ) {
			$dropped = array_merge( $dropped, $e->errors );
			return null;
		}
	}

	/**
	 * Strict validation of one field or list value.
	 *
	 * @param array  $def   Field or list definition.
	 * @param mixed  $value The submitted value.
	 * @param string $path  Field path for error messages.
	 * @param array  $env   Site facts.
	 * @return string|array The canonical string, or the canonical list of rows.
	 * @throws Alcor_Fields_Error With every problem found in the value.
	 */
	private static function canonical_def( array $def, $value, $path, array $env ) {
		if ( 'field' === $def['type'] ) {
			return Alcor_Fields_Types::canonical( $value, $def, $path, $env );
		}
		if ( ! is_array( $value ) || ! array_is_list( $value ) ) {
			throw Alcor_Fields_Error::at( $path, 'must be a list of items' );
		}
		if ( count( $value ) < $def['min'] || count( $value ) > $def['max'] ) {
			throw Alcor_Fields_Error::at( $path, 'needs ' . $def['min'] . ' to ' . $def['max'] . ' items' );
		}
		$rows   = array();
		$errors = array();
		foreach ( $value as $index => $row ) {
			$row_path = $path . '[' . $index . ']';
			if ( ! is_array( $row ) || ( $row && array_is_list( $row ) ) ) {
				$errors[] = array(
					'path'    => $row_path,
					'message' => 'must be an object',
				);
				continue;
			}
			foreach ( array_keys( $row ) as $name ) {
				if ( ! isset( $def['item'][ $name ] ) ) {
					$errors[] = array(
						'path'    => $row_path . '.' . $name,
						'message' => 'no such field in this item',
					);
				}
			}
			$clean = array();
			foreach ( $def['item'] as $key => $item_def ) {
				if ( ! array_key_exists( $key, $row ) ) {
					$errors[] = array(
						'path'    => $row_path . '.' . $key,
						'message' => 'is missing',
					);
					continue;
				}
				try {
					$clean[ $key ] = self::canonical_def( $item_def, $row[ $key ], $row_path . '.' . $key, $env );
				} catch ( Alcor_Fields_Error $e ) {
					$errors = array_merge( $errors, $e->errors );
				}
			}
			$rows[] = $clean;
		}
		if ( $errors ) {
			throw Alcor_Fields_Error::many( $errors );
		}
		return $rows;
	}

	/**
	 * Merges the authored defaults with stored values: the full content of the page, as an export carries it.
	 *
	 * @param array $sparse Validated sparse values.
	 * @return array Every top-level field key => its value or default.
	 */
	public function resolved( array $sparse ) {
		$out = array();
		foreach ( $this->fields as $key => $def ) {
			$out[ $key ] = array_key_exists( $key, $sparse ) ? $sparse[ $key ] : $def['default'];
		}
		return $out;
	}

	/**
	 * Describes the template as JSON-ready data for the editor and the REST API.
	 *
	 * @return array{template_sha256: string, groups: array} Fields grouped by the section they sit in.
	 */
	public function schema() {
		$describe = static function ( array $defs ) use ( &$describe ) {
			$out = array();
			foreach ( $defs as $key => $def ) {
				$item = array(
					'key'     => $key,
					'type'    => $def['type'],
					'label'   => $def['label'],
					'help'    => $def['help'],
					'element' => $def['element'],
					'default' => $def['default'],
				);
				if ( 'list' === $def['type'] ) {
					$item += array(
						'min'  => $def['min'],
						'max'  => $def['max'],
						'item' => $describe( $def['item'] ),
					);
				} else {
					$item += array(
						'kind'      => $def['kind'],
						'attr'      => $def['attr'],
						'max'       => $def['max'],
						'required'  => $def['required'],
						'multiline' => $def['multiline'],
						'classes'   => $def['classes'] ?? array(),
						'no_links'  => ! empty( $def['no_links'] ),
					);
				}
				$out[] = $item;
			}
			return $out;
		};
		$groups = array();
		$page   = array_filter(
			$this->fields,
			static function ( $def ) {
				return null === $def['section'];
			}
		);
		if ( $page ) {
			$groups[] = array(
				'key'      => '',
				'label'    => 'Page',
				'help'     => '',
				'hideable' => false,
				'fields'   => $describe( $page ),
			);
		}
		foreach ( $this->sections as $key => $section ) {
			$fields   = array_filter(
				$this->fields,
				static function ( $def ) use ( $key ) {
					return $def['section'] === $key;
				}
			);
			$groups[] = array(
				'key'      => $key,
				'label'    => $section['label'],
				'help'     => $section['help'],
				'hideable' => ! $section['required'],
				'fields'   => $describe( $fields ),
			);
		}
		return array(
			'template_sha256' => $this->sha256,
			'groups'          => $groups,
		);
	}

	/* ------------------------------------------------------------------ render */

	/**
	 * Renders the page.
	 *
	 * Output is escaped here as well as validated on the way in: text fields are escaped, inline fields were
	 * rebuilt from an allowlist, attribute values are attribute-escaped.
	 *
	 * @param array    $sparse Validated values (from validate()).
	 * @param string[] $hidden Validated keys of the sections to leave out.
	 * @return string The page: the authored bytes with stored values substituted.
	 */
	public function render( array $sparse = array(), array $hidden = array() ) {
		$ctx = array(
			'mode'   => 'top',
			'values' => $sparse,
			'defs'   => $this->fields,
			'hidden' => array_flip( $hidden ),
		);
		$out = '';
		foreach ( $this->root->children as $child ) {
			$out .= $this->emit( $child, $ctx );
		}
		return $out;
	}

	/**
	 * Returns the authored document minus its data-af-* attributes, computed independently of the tree.
	 *
	 * Used as the fallback when stored content cannot be used, and by checks that compare it with render().
	 *
	 * @param string $html Authored markup.
	 * @return string
	 */
	public static function strip_annotations( $html ) {
		return preg_replace_callback(
			'/<[A-Za-z][^>]*\sdata-af[^>]*>/',
			static function ( $m ) {
				return preg_replace( '/\s+data-af[a-z-]*(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s"\'=<>`]+))?/', '', $m[0] );
			},
			$html
		);
	}

	/**
	 * Renders one node. Nodes without annotations are copied byte for byte.
	 *
	 * @param Alcor_Fields_Node $node Node.
	 * @param array             $ctx  Render context: mode, values, defs and hidden sections.
	 * @return string
	 */
	private function emit( Alcor_Fields_Node $node, array $ctx ) {
		if ( 'element' !== $node->type || ! $node->has_af ) {
			return Alcor_Fields_Html::slice( $this->html, $node->start, $node->end );
		}
		$af = $node->af;
		if ( $af && $af['section'] && isset( $ctx['hidden'][ $af['section'] ] ) ) {
			return '';
		}
		if ( $af && $af['when'] && array_intersect_key( $ctx['hidden'], array_flip( $af['when'] ) ) ) {
			return '';
		}
		$out = $this->start_tag( $node, $ctx );
		if ( $node->closed_inline ) {
			return $out;
		}
		if ( $af && null !== $af['content'] ) {
			$out .= $this->content( $node, $af['content'], $ctx );
		} elseif ( $af && null !== $af['list'] ) {
			$out .= $this->list_body( $node, $af['list'], $ctx );
		} else {
			foreach ( $node->children as $child ) {
				$out .= $this->emit( $child, $ctx );
			}
		}
		return $out . Alcor_Fields_Html::slice( $this->html, $node->close_start, $node->end );
	}

	/**
	 * Finds the value for a key in the current render context.
	 *
	 * @param string $key Field key.
	 * @param array  $ctx Render context.
	 * @return array Pair of found flag and value.
	 */
	private function lookup( $key, array $ctx ) {
		if ( 'row' === $ctx['mode'] ) {
			return array( true, $ctx['row'][ $key ] );
		}
		if ( 'top' === $ctx['mode'] && array_key_exists( $key, $ctx['values'] ) ) {
			return array( true, $ctx['values'][ $key ] );
		}
		return array( false, null );
	}

	/**
	 * Renders an element's start tag, substituting the attributes that are fields.
	 *
	 * @param Alcor_Fields_Node $node Element.
	 * @param array             $ctx  Render context.
	 * @return string The start tag without data-af-* attributes.
	 */
	private function start_tag( Alcor_Fields_Node $node, array $ctx ) {
		if ( ! $node->af ) {
			return Alcor_Fields_Html::slice( $this->html, $node->start, $node->open_end );
		}
		$out = Alcor_Fields_Html::slice( $this->html, $node->start, $node->attrs[0]['start'] );
		foreach ( $node->attrs as $attr ) {
			if ( 0 === strpos( $attr['name'], 'data-af' ) ) {
				continue;
			}
			$key = $node->af['attrs'][ $attr['name'] ] ?? null;
			$hit = null !== $key ? $this->lookup( $key, $ctx ) : array( false, null );
			if ( $hit[0] ) {
				$out .= Alcor_Fields_Html::slice( $this->html, $attr['start'], $attr['name_start'] ) . $attr['name'] . '="' . Alcor_Fields_Html::esc_attr( $hit[1] ) . '"';
			} else {
				$out .= Alcor_Fields_Html::slice( $this->html, $attr['start'], $attr['end'] );
			}
		}
		return $out . Alcor_Fields_Html::slice( $this->html, end( $node->attrs )['end'], $node->open_end );
	}

	/**
	 * Renders an element's content field.
	 *
	 * @param Alcor_Fields_Node $node Element.
	 * @param string            $key  Field key.
	 * @param array             $ctx  Render context.
	 * @return string The stored value (escaped by kind), or the authored content when nothing is stored.
	 */
	private function content( Alcor_Fields_Node $node, $key, array $ctx ) {
		$hit = $this->lookup( $key, $ctx );
		if ( ! $hit[0] ) {
			return Alcor_Fields_Html::inner( $this->html, $node );
		}
		return 'inline' === $ctx['defs'][ $key ]['kind'] ? $hit[1] : Alcor_Fields_Html::esc_text( $hit[1] );
	}

	/**
	 * Renders a list: one copy of the first authored item per stored row, with the authored spacing around them.
	 *
	 * @param Alcor_Fields_Node $node Element that holds the items.
	 * @param string            $key  List key.
	 * @param array             $ctx  Render context.
	 * @return string
	 */
	private function list_body( Alcor_Fields_Node $node, $key, array $ctx ) {
		$def = $ctx['defs'][ $key ];
		$hit = $this->lookup( $key, $ctx );
		if ( ! $hit[0] ) {
			$raw = array(
				'mode'   => 'raw',
				'defs'   => $def['item'],
				'hidden' => $ctx['hidden'],
			);
			$out = '';
			foreach ( $node->children as $child ) {
				$out .= $this->emit( $child, $raw );
			}
			return $out;
		}
		$items = $node->element_children();
		$first = $items[0];
		$last  = end( $items );
		$lead  = Alcor_Fields_Html::slice( $this->html, $node->open_end, $first->start );
		$sep   = count( $items ) > 1 ? Alcor_Fields_Html::slice( $this->html, $first->end, $items[1]->start ) : $lead;
		$trail = Alcor_Fields_Html::slice( $this->html, $last->end, $node->close_start );
		$parts = array();
		foreach ( $hit[1] as $row ) {
			$parts[] = $this->emit(
				$first,
				array(
					'mode'   => 'row',
					'row'    => $row,
					'defs'   => $def['item'],
					'hidden' => $ctx['hidden'],
				)
			);
		}
		return $lead . implode( $sep, $parts ) . $trail;
	}
}
